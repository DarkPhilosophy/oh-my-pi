/**
 * Contract: an advisor carries its own investigation output forever — measured
 * at ~48% of its context, re-sent on every later request. Maintenance evicts a
 * finished review's oversized tool results before the next review's prompt,
 * while the deltas it reviewed stay verbatim, and a byte-identical repeat call
 * inside one review collapses to a pointer at the copy already in context.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const FILE_CONTENTS = "export const retryBudget = 3; // advisor investigation payload\n".repeat(32);
const READ_CALL = { type: "toolCall", name: "read", arguments: { path: "src/retry.ts" } } as const;

describe("advisor stale tool-result eviction", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-tool-result-eviction-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(async () => {
		authStorage.close();
		await tempDir.remove();
	});

	function createAdvisor(advisorResponses: MockResponse[], primaryTurns: number) {
		const primaryMock = createMockModel({
			provider: "anthropic",
			responses: Array.from({ length: primaryTurns }, () => ({ content: ["primary complete"] })),
		});
		const advisorMock = createMockModel({ provider: "anthropic", responses: advisorResponses });
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Mock read tool",
			parameters: type({ "path?": "string" }),
			execute: async () => ({ content: [{ type: "text", text: FILE_CONTENTS }], details: {} }),
		};
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: primaryMock, systemPrompt: [], tools: [] },
				streamFn: primaryMock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			advisorTools: [readTool],
			advisorStreamFn: advisorMock.stream,
		});
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be active");
		return { session, advisor, advisorMock };
	}

	function toolResultTexts(messages: readonly { role: string; content?: unknown }[]): string[] {
		const texts: string[] = [];
		for (const message of messages) {
			if (message.role !== "toolResult") continue;
			const content = message.content;
			if (typeof content === "string") texts.push(content);
			else if (Array.isArray(content)) {
				for (const block of content) {
					if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
						texts.push((block as { text: string }).text);
					}
				}
			}
		}
		return texts;
	}

	it("sends a stub instead of the finished review's file contents, keeping the delta", async () => {
		const {
			session: live,
			advisor,
			advisorMock,
		} = createAdvisor(
			[{ content: [READ_CALL] }, { content: ["Reviewed the retry path."] }, { content: ["Nothing new."] }],
			2,
		);

		await live.prompt("first update: change the retry budget");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);
		await live.prompt("second update: adjust the backoff");
		expect(await live.waitForAdvisorCatchup(2_000)).toBe(true);

		expect(advisorMock.calls).toHaveLength(3);
		expect(advisor.state.error).toBeUndefined();

		// Review 1 read the file verbatim; review 2 must not pay for it again.
		expect(toolResultTexts(advisorMock.calls[1].context.messages)).toContain(FILE_CONTENTS);
		const secondReview = advisorMock.calls[2].context.messages;
		const results = toolResultTexts(secondReview);
		expect(results.some(text => text.startsWith("[Stale result elided - "))).toBe(true);
		expect(results).not.toContain(FILE_CONTENTS);
		// The work under review is never touched — only the advisor's own output.
		expect(JSON.stringify(secondReview)).toContain("first update: change the retry budget");
	});
});
