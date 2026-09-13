import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { Composer } from "../src/modes/composer";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

let directory: TempDir;
let auth: AuthStorage;
let session: AgentSession;
let mode: InteractiveMode;
let terminal: VirtualTerminal;
let providerCalls: number;
let credentialCalls: number;
let beforeAssistantEnd: (() => Promise<void>) | undefined;

beforeEach(async () => {
	directory = await TempDir.create("omp-render-test-");
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: directory.path(), agentDir: directory.path() });
	auth = await AuthStorage.create(":memory:");
	providerCalls = 0;
	credentialCalls = 0;
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		initialState: { model, tools: [] },
		getApiKey: () => {
			credentialCalls++;
			throw new Error("Render requested credentials");
		},
		streamFn: () => {
			providerCalls++;
			throw new Error("Render contacted a provider");
		},
	});
	beforeAssistantEnd = undefined;
	const sessionManager = SessionManager.inMemory(directory.path());
	const modelRegistry = new ModelRegistry(auth, directory.join("models.yml"));
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		api => {
			api.on("message_end", async event => {
				if (event.message.role === "assistant") await beforeAssistantEnd?.();
			});
		},
		directory.path(),
		new EventBus(),
		runtime,
		"render-event-ordering",
	);
	session = new AgentSession({
		agent,
		sessionManager,
		builtInToolNames: ["read", "edit", "todo", "ask", "bash", "hub"],
		settings: Settings.isolated({
			"startup.quiet": true,
			"compaction.enabled": false,
			"read.toolResultPreview": true,
		}),
		modelRegistry,
		extensionRunner: new ExtensionRunner([extension], runtime, directory.path(), sessionManager, modelRegistry),
	});
	terminal = new VirtualTerminal(110, 20, 10_000);
	const composer = new Composer({ terminal, preferences: { quiet: true } });
	mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	await mode.init({ suppressWelcomeIntro: true });
});

afterEach(async () => {
	await session?.abort();
	mode?.stop();
	await session?.dispose();
	auth?.close();
	await directory?.remove();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

it("restores bottom-anchored chat after the TODO scenario dismisses its completed panel", async () => {
	session.settings.override("tasks.todoClearDelay", 4);
	await session.runRenderTest({ repeat: 1, delayMs: 1, scenario: "todo" }, mode.getToolUIContext());
	await session.waitForIdle();
	await terminal.waitForRender(() => mode.todoContainer.children.length === 0);
	const viewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	expect(viewport.at(-1)).toContain("╰─");
	const tape = terminal
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row))
		.join("\n");
	expect(Array.from(tape.matchAll(/TODO_CONTEXT_\d+/g), match => match[0])).toEqual(
		Array.from({ length: 40 }, (_, index) => `TODO_CONTEXT_${index + 1}`),
	);
	expect(providerCalls).toBe(0);
	expect(credentialCalls).toBe(0);
}, 30_000);

it.each(["ask", "job", "markdown"] as const)(
	"runs the isolated %s scenario without unrelated tools",
	async scenario => {
		const calls: string[] = [];
		const output: string[] = [];
		const question = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "tool_execution_start") {
				calls.push(event.toolName);
				if (event.toolName === "ask") question.resolve();
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				for (const block of event.message.content) if (block.type === "text") output.push(block.text);
			}
		});
		try {
			const running = session.runRenderTest({ repeat: 1, delayMs: 1, scenario }, mode.getToolUIContext());
			if (scenario === "ask") {
				await question.promise;
				await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("Enter select")));
				expect(terminal.getViewport().some(row => row.includes("Enter select"))).toBeTrue();
				terminal.sendInput("\r");
			}
			await running;
			await session.waitForIdle();
			if (scenario === "ask") expect(calls).toEqual(["ask"]);
			else if (scenario === "job")
				expect(calls).toEqual([...Array<string>(11).fill("bash"), ...Array<string>(4).fill("hub")]);
			else {
				expect(calls).toEqual([]);
				const body = output.join("").split("\n").slice(1, -1);
				expect(body).toHaveLength(50);
				expect(body.map(line => line.slice(0, 11))).toEqual(
					Array.from({ length: 50 }, (_, index) => `MARKDOWN_${String(index + 1).padStart(2, "0")}`),
				);
				mode.ui.renderNow();
				await terminal.waitForRender();
				const tape = terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row))
					.join("\n");
				expect(Array.from(tape.matchAll(/MARKDOWN_\d+/g), match => match[0])).toEqual(
					body.map(line => line.slice(0, 11)),
				);
			}
			expect(providerCalls).toBe(0);
			expect(credentialCalls).toBe(0);
		} finally {
			unsubscribe();
		}
	},
	60_000,
);

it.each([20, 30, 40, 60])(
	"keeps concurrent job cards adjacent in a %i-row terminal",
	async height => {
		terminal.resize(110, height);
		mode.ui.requestRender(true);
		const gaps: string[] = [];
		const duplicatedSections: string[] = [];
		const write = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			write(data);
			const rows = terminal
				.getScrollBuffer()
				.slice(-200)
				.map(row => Bun.stripANSI(row).trimEnd());
			let cardStart = -1;
			let outputSections = 0;
			for (let index = 0; index < rows.length; index++) {
				if (rows[index]?.startsWith("╭")) {
					cardStart = index;
					outputSections = 0;
				}
				if (cardStart >= 0 && rows[index]?.startsWith("├─── Output")) {
					outputSections++;
					if (outputSections > 1) duplicatedSections.push(rows.slice(cardStart, index + 1).join("\n"));
				}
				if (rows[index]?.startsWith("╰")) cardStart = -1;
			}
			for (let index = 0; index < rows.length; index++) {
				if (!rows[index]?.startsWith("╰")) continue;
				let next = index + 1;
				while (next < rows.length && rows[next] === "") next++;
				if (next - index > 2 && rows[next]?.startsWith("╭")) {
					gaps.push(rows.slice(index, next + 1).join("\n"));
				}
			}
		});
		await session.runRenderTest({ repeat: 1, delayMs: 5, scenario: "job" }, mode.getToolUIContext());
		await session.waitForIdle();
		await terminal.waitForRender();
		expect(gaps).toEqual([]);
		expect(duplicatedSections).toEqual([]);
		const tape = terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(Array.from(tape.matchAll(/STEP_\d+/g), match => match[0])).toEqual(["STEP_1", "STEP_2", "STEP_3"]);
	},
	60_000,
);

it.each([20, 40])(
	"runs complete workflows in a %i-row terminal through real tools without provider calls",
	async rows => {
		terminal.resize(110, rows);
		mode.ui.requestRender(true);
		await terminal.waitForRender();
		const duplicateFrames: string[] = [];
		const splitCards: string[] = [];
		const write = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			write(data);
			const paintedRows = terminal
				.getScrollBuffer()
				.slice(-200)
				.map(row => Bun.stripANSI(row).trimEnd());
			for (let index = 1; index < paintedRows.length - 1; index++) {
				if (paintedRows[index] !== "" || !/^[│├╭]/.test(paintedRows[index - 1]!)) continue;
				let next = index + 1;
				while (paintedRows[next] === "") next++;
				if (/^[│├╰]/.test(paintedRows[next] ?? "")) {
					splitCards.push(paintedRows.slice(Math.max(0, index - 3), next + 3).join("\n"));
				}
			}
			if (duplicateFrames.length > 0) return;
			const frame = terminal
				.getScrollBuffer()
				.slice(-200)
				.map(row => Bun.stripANSI(row))
				.join("\n");
			const starts = Array.from(frame.matchAll(/Streaming \d+ — BEGIN/g), match => match[0]);
			if (new Set(starts).size !== starts.length) duplicateFrames.push(frame);
		});
		const results: ToolResultMessage[] = [];
		const assistants: AssistantMessage[] = [];
		const questions = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const streamingStarted = Promise.withResolvers<void>();
		let questionCount = 0;
		let assistantStarts = 0;
		let thinkingDeltas = 0;
		let textDeltas = 0;
		const savedTodo = [
			{ name: "Existing", tasks: [{ content: "Keep the user's original plan", status: "pending" as const }] },
		];
		session.setTodoPhases(savedTodo);
		const runStates: string[] = [];
		session.subscribeRunState(state => runStates.push(state));
		session.subscribe(event => {
			if (event.type === "message_start" && event.message.role === "assistant") assistantStarts++;
			if (event.type === "message_update") {
				if (event.assistantMessageEvent.type === "thinking_delta") thinkingDeltas++;
				if (event.assistantMessageEvent.type === "text_delta") {
					textDeltas++;
					streamingStarted.resolve();
				}
			}
			if (event.type === "tool_execution_start" && event.toolName === "ask") questions[questionCount++]?.resolve();
			if (event.type === "message_end" && event.message.role === "toolResult") results.push(event.message);
			if (event.type === "message_end" && event.message.role === "assistant") assistants.push(event.message);
		});
		const running = session.runRenderTest({ repeat: 2, delayMs: 1 }, mode.getToolUIContext());
		await streamingStarted.promise;
		terminal.sendInput("draft");
		for (let repetition = 0; repetition < 2; repetition++) {
			await questions[repetition]!.promise;
			if (repetition === 0) {
				await terminal.waitForRender(() =>
					terminal.getViewport().some(row => row.includes("Finish or clear the current prompt")),
				);
				expect(terminal.getViewport().some(row => row.includes("Finish or clear the current prompt"))).toBeTrue();
				terminal.sendInput("\r");
			}
			await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("Enter select")));
			expect(terminal.getViewport().some(row => row.includes("Enter select"))).toBeTrue();
			const count = assistantStarts;
			await Bun.sleep(100);
			expect(assistantStarts).toBe(count);
			expect(questionCount).toBe(repetition + 1);
			expect(session.isStreaming).toBeTrue();
			terminal.sendInput("\r");
		}
		await running;
		await session.waitForIdle();
		mode.ui.renderNow();
		await terminal.waitForRender();
		expect(session.isStreaming).toBeFalse();
		expect(runStates).toEqual(["running", "idle"]);
		expect(session.getTodoPhases()).toEqual(savedTodo);
		expect(duplicateFrames).toEqual([]);
		expect(splitCards).toEqual([]);
		expect(thinkingDeltas).toBeGreaterThan(2);
		expect(textDeltas).toBeGreaterThan(100);
		expect(results.filter(result => result.toolName === "read")).toHaveLength(20);
		const edits = results.filter(result => result.toolName === "edit");
		expect(edits).toHaveLength(8);
		expect(edits.filter(result => result.isError)).toHaveLength(2);
		for (const error of edits.filter(result => result.isError)) {
			expect(
				error.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join("\n"),
			).toMatch(/snapshot|hash|stale/i);
		}
		expect(results.filter(result => result.toolName === "ask" && !result.isError)).toHaveLength(2);
		expect(results.filter(result => result.toolName === "bash" && !result.isError)).toHaveLength(22);
		expect(results.filter(result => result.toolName === "hub" && !result.isError)).toHaveLength(8);
		for (const repetition of [1, 2]) {
			expect(
				assistants.some(
					message =>
						message.content
							.filter(block => block.type === "toolCall")
							.filter(call => call.name === "edit" && call.id.startsWith(`render-workflow-${repetition}-`))
							.length === 3,
				),
			).toBeTrue();
		}
		const text = assistants
			.flatMap(message => message.content.flatMap(block => (block.type === "text" ? [block.text] : [])))
			.join("\n");
		const expected = Array.from(text.matchAll(/(?:PLAIN|QUOTE|TABLE|CODE|LIST|STEP)_\d+/g), match => match[0]);
		const tape = terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(
			Array.from(tape.matchAll(/(?:PLAIN|QUOTE|TABLE|CODE|LIST|STEP)_\d+/g), match => match[0]),
			tape.slice(tape.indexOf("STEP_130"), tape.indexOf("STEP_132") + 200),
		).toEqual(expected);
		const boundaries = /Streaming \d+ — (?:BEGIN|END)/g;
		expect(Array.from(tape.matchAll(boundaries), match => match[0])).toEqual(
			Array.from(text.matchAll(boundaries), match => match[0]),
		);
		const firstReads = tape.slice(tape.indexOf("Streaming 2 — BEGIN"), tape.indexOf("Streaming 3 — BEGIN"));
		for (const file of [1, 2, 3]) {
			expect(firstReads).toContain(`Fixture ${file}, row 1:`);
			expect(firstReads).toContain(`Fixture ${file}, row 3:`);
		}
		expect(expected.filter(marker => marker.startsWith("PLAIN_"))).toHaveLength(120);
		expect(expected.filter(marker => marker.startsWith("CODE_"))).toHaveLength(120);
		expect(providerCalls).toBe(0);
		expect(credentialCalls).toBe(0);
	},
	180_000,
);

it("cancels paced output and rejects an overlapping run without starting a provider", async () => {
	const firstDelta = Promise.withResolvers<void>();
	let final: AssistantMessage | undefined;
	const runStates: string[] = [];
	session.subscribeRunState(state => runStates.push(state));
	session.subscribe(event => {
		if (event.type === "message_update") firstDelta.resolve();
		if (event.type === "message_end" && event.message.role === "assistant") final = event.message;
	});
	const running = session.runRenderTest({ repeat: 2, delayMs: 5 }, mode.getToolUIContext());
	await firstDelta.promise;
	await expect(session.runRenderTest({ repeat: 1, delayMs: 1 }, mode.getToolUIContext())).rejects.toThrow();
	await session.abort();
	await running;
	expect(session.isStreaming).toBeFalse();
	expect(runStates).toEqual(["running", "idle"]);
	expect(final?.stopReason).toBe("aborted");
	expect(final?.content.some(block => block.type === "text")).toBeFalse();
	expect(providerCalls).toBe(0);
	expect(credentialCalls).toBe(0);
});

it("keeps terminal completion behind an asynchronous assistant message-end handler", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const delta = Promise.withResolvers<void>();
	const delivered: string[] = [];
	beforeAssistantEnd = async () => {
		entered.resolve();
		await release.promise;
	};
	session.subscribe(event => {
		if (event.type === "message_update") delta.resolve();
		if (event.type === "message_end" && event.message.role === "assistant") delivered.push("message_end");
		if (event.type === "agent_end") delivered.push("agent_end");
	});
	const running = session.runRenderTest({ repeat: 1, delayMs: 5 }, mode.getToolUIContext());
	await delta.promise;
	const aborting = session.abort();
	try {
		await entered.promise;
		await Bun.sleep(20);
		expect(delivered).toEqual([]);
		expect(session.isStreaming).toBeTrue();
	} finally {
		release.resolve();
		await Promise.all([running, aborting]);
	}
	expect(delivered).toEqual(["message_end", "agent_end"]);
	expect(session.isStreaming).toBeFalse();
});
