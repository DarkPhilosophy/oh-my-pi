import { afterEach, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as judgment from "@oh-my-pi/pi-coding-agent/judgment";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const boundaryToolSchema = type({});
type BoundaryTool = AgentTool<typeof boundaryToolSchema, undefined>;

function textResponse(text: string): MockResponse {
	return { content: [text], stopReason: "stop" };
}

function toolResponse(id: string, name: string, args: Record<string, unknown> = {}): MockResponse {
	return { content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
			return "";
		})
		.join("\n");
}

function makeTool(name: string, execute: BoundaryTool["execute"]): BoundaryTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: boundaryToolSchema,
		execute,
	};
}

let active: { session: AgentSession; auth: AuthStorage; temp: TempDir } | undefined;

afterEach(async () => {
	await active?.session.dispose().catch(() => {});
	active?.auth.close();
	await active?.temp.remove().catch(() => {});
	active = undefined;
	vi.restoreAllMocks();
});

it.each(["concern", "nit", "blocker"] as const)(
	"routes late terminal %s correctly before a real next run",
	async severity => {
		const temp = TempDir.createSync("@pi-advisor-terminal-unwind-");
		const auth = await AuthStorage.create(":memory:");
		auth.keys.setRuntime("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const nextUserMarker = "NEXT_USER_CONTEXT_MARKER";
		const terminalTurnEnd = Promise.withResolvers<void>();
		const advisorStarted = Promise.withResolvers<void>();
		const releaseAdvisor = Promise.withResolvers<void>();
		const adviceAccepted = Promise.withResolvers<{ feedback: string; streaming: boolean }>();
		const nextProviderStarted = Promise.withResolvers<void>();
		const releaseNextProvider = Promise.withResolvers<void>();
		const nextPrimaryCall = severity === "blocker" ? 4 : 3;
		let primaryCalls = 0;
		const primaryContexts: string[] = [];
		let advisorCalls = 0;
		let terminalReleaseStarted = false;

		const primaryMock = createMockModel({
			id: "terminal-unwind-primary",
			provider: "anthropic",
			handler: async () => {
				if (primaryCalls === 1) return toolResponse("step-1", "step");
				if (primaryCalls === 2) return textResponse("terminal answer");
				if (primaryCalls === nextPrimaryCall) {
					nextProviderStarted.resolve();
					await releaseNextProvider.promise;
					return textResponse("next answer");
				}
				return textResponse("continuation answer");
			},
		});
		const advisorMock = createMockModel({
			id: "terminal-unwind-advisor",
			provider: "anthropic",
			handler: async () => {
				if (++advisorCalls === 1) {
					advisorStarted.resolve();
					await releaseAdvisor.promise;
					return toolResponse("advice-1", "advise", {
						note: "late terminal advice",
						severity,
					});
				}
				return textResponse("advisor quiet");
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: ["terminal unwind regression"],
				tools: [makeTool("step", async () => ({ content: [{ type: "text", text: "step complete" }] }))],
			},
			streamFn: (messages, context, options) => {
				primaryCalls++;
				primaryContexts.push(JSON.stringify(context.messages));
				return primaryMock.stream(messages, context, options);
			},
		});
		const originalSetOnTurnEnd = agent.setOnTurnEnd.bind(agent);
		agent.setOnTurnEnd = callback => {
			if (!callback) {
				originalSetOnTurnEnd(undefined);
				return;
			}
			originalSetOnTurnEnd(async (messages, signal, context) => {
				await callback(messages, signal, context);
				if (context?.willContinue === false && !terminalReleaseStarted) {
					terminalReleaseStarted = true;
					terminalTurnEnd.resolve();
					releaseAdvisor.resolve();
					await adviceAccepted.promise;
				}
			});
		};

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"advisor.syncBacklog": "off",
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		active = { session, auth, temp };
		if (!session.setAdvisorEnabled(true)) throw new Error("Expected advisor runtime");
		let agentStarts = 0;
		const secondAgentStart = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type !== "agent_start") return;
			agentStarts++;
			if (agentStarts === 2) secondAgentStart.resolve();
		});
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent");
		const advise = advisor.state.tools.find(tool => tool.name === "advise");
		if (!advise) throw new Error("Expected advise tool");
		const originalExecute = advise.execute.bind(advise);
		advise.execute = async (...args) => {
			const result = await originalExecute(...args);
			const feedback = contentText(result.content);
			if (/Delivered|Queued|preserved|urgent/i.test(feedback)) {
				adviceAccepted.resolve({ feedback, streaming: agent.state.isStreaming });
			}
			return result;
		};

		const run = session.prompt("run a step then finish");
		await advisorStarted.promise;
		await terminalTurnEnd.promise;
		const accepted = await adviceAccepted.promise;
		await run;
		await session.waitForIdle();

		expect(accepted.streaming).toBe(true);
		const terminalCalls = severity === "blocker" ? 3 : 2;
		expect(primaryCalls).toBe(terminalCalls);
		const cards = session.agent.state.messages.filter(
			(message: AgentMessage) =>
				message.role === "custom" && "customType" in message && message.customType === "advisor",
		);
		expect(cards).toHaveLength(1);
		if (severity !== "blocker") {
			const card = cards[0];
			expect(card?.role).toBe("custom");
			if (card?.role === "custom") expect(contentText(card.content)).toContain("late terminal advice");
		}

		const nextRun = session.prompt(nextUserMarker);
		await secondAgentStart.promise;
		await nextProviderStarted.promise;
		expect(session.agent.state.isStreaming).toBe(true);
		const liveResult = await advise.execute("live-next", {
			note: "live next-turn concern",
			severity: "concern",
		});
		expect(contentText(liveResult.content)).toMatch(/Delivered|Queued/);
		releaseNextProvider.resolve();
		await nextRun;
		await session.waitForIdle();
		expect(agentStarts).toBe(2);
		// The live concern steers one continuation after the held next-user
		// provider request. After a terminal blocker it does not: that blocker
		// already steered its own continuation, and the post-interrupt cooldown
		// downgrades the following concern to an aside, which rides the running
		// turn instead of starting another one.
		expect(primaryCalls).toBe(severity === "blocker" ? terminalCalls + 1 : terminalCalls + 2);
		expect(primaryContexts[terminalCalls]).toContain(nextUserMarker);
	},
);

it.each([true, false])("delivers only surviving terminal advice (all dropped: %s)", async allDropped => {
	const temp = TempDir.createSync("@pi-advisor-empty-batch-");
	const auth = await AuthStorage.create(":memory:");
	auth.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	let primaryCalls = 0;
	let advisorCalls = 0;
	const primary = createMockModel({
		id: "curated-boundary-primary",
		provider: "anthropic",
		handler: async () => {
			primaryCalls++;
			return textResponse("Task completed");
		},
	});
	const reviewer = createMockModel({
		id: "curated-boundary-advisor",
		provider: "anthropic",
		handler: async () =>
			++advisorCalls === 1
				? {
						content: [
							{
								type: "toolCall",
								id: "nit-a",
								name: "advise",
								arguments: { note: "Completed check A", severity: "nit" },
							},
							{
								type: "toolCall",
								id: "nit-b",
								name: "advise",
								arguments: { note: "Completed check B", severity: "nit" },
							},
						],
						stopReason: "toolUse",
					}
				: textResponse("Review complete"),
	});
	const judge = vi.fn(async () => ({
		answers: {
			"addressed:0": { type: "noul", noul: 1 },
			"addressed:1": { type: "noul", noul: allDropped ? 1 : 0 },
		},
	}));
	vi.spyOn(judgment, "resolveJudge").mockReturnValue({ judge } as unknown as judgment.ChainJudge);
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"advisor.syncBacklog": "strict",
		"advisor.curator": "auto",
	});
	settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: primary.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(auth, temp.join("models.yml")),
		advisorTools: [],
		advisorStreamFn: reviewer.stream,
	});
	active = { session, auth, temp };
	expect(session.setAdvisorEnabled(true)).toBe(true);
	const send = vi.spyOn(session, "sendCustomMessage");
	await session.prompt("Complete the task");
	await session.waitForIdle();
	expect(judge).toHaveBeenCalledTimes(1);
	const cards = session.messages.filter(message => message.role === "custom" && message.customType === "advisor");
	expect(cards).toHaveLength(allDropped ? 0 : 1);
	if (!allDropped) {
		const card = cards[0];
		if (card?.role !== "custom") throw new Error("Expected surviving advisor message");
		const content = contentText(card.content);
		expect(content).toContain("<advisory");
		expect(content).toContain("Completed check B");
		expect(content).not.toContain("Completed check A");
		expect(content).toContain('already-addressed="1"');
	}
	expect(send).not.toHaveBeenCalled();
	expect(primaryCalls).toBe(1);
});
