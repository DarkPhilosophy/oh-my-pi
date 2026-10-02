import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir, parseStreamingJson } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import { Text } from "@oh-my-pi/pi-tui";
import { setIrcMessageVisibleTtlForTest } from "../src/modes/controllers/event-controller";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";
import * as renderWorkflow from "../src/session/render-workflow";
import { cfgReadGroupAcrossStreams, cfgTasksTodoClearDelay } from "@oh-my-pi/pi-coding-agent/tools/settings";

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
		builtInToolNames: ["read", "edit", "todo", "ask", "bash", "hub", "eval"],
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

it.each([8, 12, 20, 40])(
	"preserves completed read output during a pending batch at %s terminal rows",
	async rows => {
		terminal.resize(110, rows);
		mode.setToolsExpanded(true);
		const files = [0, 1, 2, 3].map(i => path.resolve(directory.join("stream-read-" + i + ".txt")));
		const expected = files.map((_, i) =>
			Array.from({ length: 120 }, (_, row) => "READ_" + i + "_ROW_" + String(row).padStart(3, "0")),
		);
		await Promise.all(files.map((file, i) => Bun.write(file, expected[i]!.join("\n"))));
		const entered = files.map(() => Promise.withResolvers<void>());
		const release = files.map(() => Promise.withResolvers<void>());
		const completed = files.map(() => Promise.withResolvers<void>());
		const calls = files.map((file, i) => ({
			type: "toolCall" as const,
			id: "stable-read-" + i,
			name: "read",
			arguments: { path: file + ":1-120" },
		}));
		let resets = 0;
		const stopPaints = mode.ui.addPaintListener(paint => {
			if (paint.reset) resets++;
		});
		const results = new Map<string, { isError: boolean; markers: string[] }>();
		const markers = (text: string) => Array.from(text.matchAll(/READ_[0-3]_ROW_\d{3}/g), m => m[0]);
		const tape = () =>
			terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row))
				.join("\n");
		const history = () =>
			terminal
				.getScrollBuffer()
				.slice(0, -terminal.rows)
				.map(row => Bun.stripANSI(row))
				.join("\n");
		const factory = renderWorkflow.createRenderWorkflow;
		vi.spyOn(renderWorkflow, "createRenderWorkflow").mockImplementation((...args) => {
			const workflow = factory(...args);
			let sent = false;
			workflow.next = async () => {
				if (sent) return undefined;
				sent = true;
				return { calls, introduction: false, repetition: 1 };
			};
			const read = workflow.tools.find(tool => tool.name === "read")!;
			const execute = read.execute.bind(read);
			vi.spyOn(read, "execute").mockImplementation(async (...args) => {
				const i = calls.findIndex(call => call.id === args[0]);
				entered[i]!.resolve();
				await release[i]!.promise;
				return execute(...args);
			});
			return workflow;
		});
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "tool_execution_end") return;
			const i = calls.findIndex(call => call.id === event.toolCallId);
			if (i < 0) return;
			results.set(event.toolCallId, {
				isError: event.isError === true,
				markers: markers(
					(event.result.content as ToolResultMessage["content"])
						.flatMap(block => (block.type === "text" ? [block.text] : []))
						.join("\n"),
				),
			});
			completed[i]!.resolve();
		});
		const running = session.runRenderTest({ repeat: 1, delayMs: 1 }, mode.getToolUIContext());
		try {
			await Promise.all(entered.map(barrier => barrier.promise));
			await terminal.waitForRender(() => terminal.getViewport().join("\n").includes("Read (4)"));
			expect(terminal.getViewport().join("\n")).toContain("Read (4)");
			for (let i = 0; i < calls.length; i++) {
				release[i]!.resolve();
				await completed[i]!.promise;
				await terminal.waitForRender(
					() => !mode.pendingTools.has(calls[i]!.id) && markers(tape()).includes(expected[i]![119]!),
				);
				mode.ui.renderNow();
				await terminal.waitForRender();
				expect(results.get(calls[i]!.id)).toEqual({ isError: false, markers: expected[i] });
				expect(markers(tape())).toEqual(expected.slice(0, i + 1).flat());
				const viewport = terminal
					.getViewport()
					.map(row => Bun.stripANSI(row))
					.join("\n");
				expect(viewport).toContain("Read (4)");
				if (i < calls.length - 1) expect(viewport).toContain("stream-read-3.txt");
				if (i < calls.length - 1) {
					const resetCheckpoint = resets;
					for (let paint = 0; paint < 3; paint++) {
						mode.ui.requestRender();
						await terminal.waitForRender();
					}
					expect(resets).toBe(resetCheckpoint);
				}
				expect(markers(tape())).toEqual(expected.slice(0, i + 1).flat());
				if (i < calls.length - 1) {
					expect(session.isStreaming).toBeTrue();
					expect(markers(history())).toContain(expected[i]![0]!);
					for (let later = i + 1; later < calls.length; later++)
						expect(mode.pendingTools.has(calls[later]!.id)).toBeTrue();
				}
			}
			await running;
			await session.waitForIdle();
			await terminal.waitForRender();
			expect(markers(tape())).toEqual(expected.flat());
			expect(providerCalls).toBe(0);
			expect(credentialCalls).toBe(0);
		} finally {
			for (const barrier of release) barrier.resolve();
			try {
				await running;
			} finally {
				unsubscribe();
				stopPaints();
			}
		}
	},
	30000,
);

it.each([true, false])(
	"publishes completed collapsed reads with cross-stream grouping %s before another response",
	async crossStream => {
		cfgReadGroupAcrossStreams.override(session.settings, crossStream);
		terminal.resize(110, 100);
		mode.setToolsExpanded(false);
		const files = [0, 1].map(index => path.resolve(directory.join("collapsed-" + index + ".txt")));
		await Promise.all(
			files.map((file, index) =>
				Bun.write(file, Array.from({ length: 90 }, (_, row) => "COLLAPSED_" + index + "_" + row).join("\n")),
			),
		);
		const entered = files.map(() => Promise.withResolvers<void>());
		const release = files.map(() => Promise.withResolvers<void>());
		const completed = files.map(() => Promise.withResolvers<void>());
		const allResults = Promise.withResolvers<void>();
		const nextResponse = Promise.withResolvers<void>();
		const errors: string[] = [];
		const factory = renderWorkflow.createRenderWorkflow;
		vi.spyOn(renderWorkflow, "createRenderWorkflow").mockImplementation((...args) => {
			const workflow = factory(...args);
			let sent = false;
			workflow.next = async () => {
				if (sent) {
					allResults.resolve();
					await nextResponse.promise;
					return undefined;
				}
				sent = true;
				return {
					calls: files.map((file, index) => ({
						type: "toolCall" as const,
						id: "collapsed-call-" + index,
						name: "read",
						arguments: { path: file + ":1-90" },
					})),
					introduction: false,
					repetition: 1,
				};
			};
			const read = workflow.tools.find(tool => tool.name === "read")!;
			const execute = read.execute.bind(read);
			vi.spyOn(read, "execute").mockImplementation(async (...executeArgs) => {
				const index = Number(executeArgs[0].at(-1));
				entered[index]!.resolve();
				await release[index]!.promise;
				return execute(...executeArgs);
			});
			return workflow;
		});
		const stop = session.subscribe(event => {
			if (event.type !== "tool_execution_end" || !event.toolCallId.startsWith("collapsed-call-")) return;
			if (event.isError) errors.push(event.toolCallId);
			completed[Number(event.toolCallId.at(-1))]!.resolve();
		});
		const running = session.runRenderTest({ repeat: 1, delayMs: 1 }, mode.getToolUIContext());
		try {
			await Promise.all(entered.map(barrier => barrier.promise));
			const group = mode.pendingTools.get("collapsed-call-0");
			expect(group).toBeInstanceOf(ReadToolGroupComponent);
			if (!(group instanceof ReadToolGroupComponent)) throw Error("Expected shared read group");
			expect(mode.pendingTools.get("collapsed-call-1")).toBe(group);
			const groupIndex = mode.chatContainer.children.indexOf(group);
			release[0]!.resolve();
			await completed[0]!.promise;
			await terminal.waitForRender(() => mode.chatContainer.emittedStableRows()[groupIndex] === 1);
			expect(mode.chatContainer.emittedStableRows()[groupIndex]).toBe(1);
			expect(group.isTranscriptBlockFinalized()).toBeFalse();
			expect(session.isStreaming).toBeTrue();
			release[1]!.resolve();
			await Promise.all([completed[1]!.promise, allResults.promise]);
			await terminal.waitForRender(() =>
				crossStream
					? mode.chatContainer.emittedStableRows()[groupIndex] === 2
					: mode.chatContainer.blockStates()[groupIndex] === "committed",
			);
			if (crossStream) expect(mode.chatContainer.emittedStableRows()[groupIndex]).toBe(2);
			else expect(mode.chatContainer.blockStates()[groupIndex]).toBe("committed");
			expect(errors).toEqual([]);
			const tape = terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(tape.match(/COLLAPSED_0_0\b/g)).toHaveLength(1);
			expect(tape.match(/COLLAPSED_1_0\b/g)).toHaveLength(1);
			expect(tape).toContain("Read (2)");
			nextResponse.resolve();
			await running;
			await session.waitForIdle();
			await terminal.waitForRender(() => mode.chatContainer.blockStates()[groupIndex] === "committed");
			expect(mode.chatContainer.blockStates()[groupIndex]).toBe("committed");
			const finishedTape = terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(finishedTape.match(/COLLAPSED_0_0\b/g)).toHaveLength(1);
			expect(finishedTape.match(/COLLAPSED_1_0\b/g)).toHaveLength(1);
			expect(finishedTape.match(/Read \(2\)/g)).toHaveLength(1);
		} finally {
			for (const barrier of release) barrier.resolve();
			nextResponse.resolve();
			try {
				await running;
			} finally {
				stop();
			}
		}
	},
	30000,
);

it.each([12, 30])(
	"commits each large write before later writes finish at %s rows",
	async rows => {
		terminal.resize(110, rows);
		mode.setToolsExpanded(true);
		const content = Array.from({ length: 4 }, (_, index) =>
			Array.from({ length: 100 }, (_, row) => "WRITE_" + index + "_ROW_" + String(row).padStart(3, "0")).join("\n"),
		);
		const calls = content.map((text, index) => ({
			type: "toolCall" as const,
			id: "write-sequence-" + index,
			name: "write",
			arguments: { path: path.resolve(directory.join("sequence-" + index + ".txt")), content: text },
		}));
		const entered = calls.map(() => Promise.withResolvers<void>());
		const release = calls.map(() => Promise.withResolvers<void>());
		const completed = calls.map(() => Promise.withResolvers<void>());
		const errors: string[] = [];
		const factory = renderWorkflow.createRenderWorkflow;
		vi.spyOn(renderWorkflow, "createRenderWorkflow").mockImplementation((...args) => {
			const workflow = factory(...args);
			let sent = false;
			workflow.next = async () => {
				if (sent) return undefined;
				sent = true;
				return { calls, introduction: false, repetition: 1 };
			};
			const write = workflow.tools.find(tool => tool.name === "write")!;
			const execute = write.execute.bind(write);
			vi.spyOn(write, "execute").mockImplementation(async (...args) => {
				const index = calls.findIndex(call => call.id === args[0]);
				entered[index]!.resolve();
				await release[index]!.promise;
				return execute(...args);
			});
			return workflow;
		});
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "tool_execution_end") return;
			const index = calls.findIndex(call => call.id === event.toolCallId);
			if (index < 0) return;
			if (event.isError) errors.push(event.toolCallId);
			completed[index]!.resolve();
		});
		const markerRows = (text: string) => Array.from(text.matchAll(/WRITE_[0-3]_ROW_\d{3}/g), match => match[0]);
		const tape = () => terminal.getScrollBuffer().join("\n");
		const history = () => terminal.getScrollBuffer().slice(0, -terminal.rows).join("\n");
		const running = session.runRenderTest({ repeat: 1, delayMs: 1 }, mode.getToolUIContext());
		try {
			for (let index = 0; index < calls.length; index++) {
				await entered[index]!.promise;
				release[index]!.resolve();
				await completed[index]!.promise;
				mode.ui.renderNow();
				await terminal.waitForRender(
					() =>
						!mode.pendingTools.has(calls[index]!.id) &&
						(index < calls.length - 1 ? history() : tape()).includes("WRITE_" + index + "_ROW_099"),
				);
				expect(errors).toEqual([]);
				expect(
					markerRows(index < calls.length - 1 ? history() : tape()).filter(marker =>
						marker.startsWith("WRITE_" + index + "_"),
					),
				).toEqual(markerRows(content[index]!));
				expect(await Bun.file(calls[index]!.arguments.path).text()).toBe(content[index]!);
				if (index < calls.length - 1) {
					expect(session.isStreaming).toBeTrue();
					expect(mode.pendingTools.has(calls[index + 1]!.id)).toBeTrue();
				}
			}
			await running;
			await session.waitForIdle();
			await terminal.waitForRender();
			expect(markerRows(tape())).toEqual(content.flatMap(markerRows));
		} finally {
			for (const barrier of release) barrier.resolve();
			try {
				await running;
			} finally {
				unsubscribe();
			}
		}
	},
	30000,
);

it("retires finished results in a real mixed batch while later calls remain pending", async () => {
	terminal.resize(110, 12);
	mode.setToolsExpanded(true);
	const file = path.resolve(directory.join("mixed-input.txt"));
	const readRows = Array.from({ length: 80 }, (_, row) => "REAL_READ_" + String(row).padStart(3, "0"));
	await Bun.write(file, readRows.join("\n"));
	const calls = [
		{
			type: "toolCall" as const,
			id: "real-bash",
			name: "bash",
			arguments: { command: "printf 'REAL_BASH_DONE\\n'" },
		},
		{ type: "toolCall" as const, id: "real-read", name: "read", arguments: { path: file + ":1-80" } },
		{ type: "toolCall" as const, id: "later-read", name: "read", arguments: { path: file + ":1-80" } },
		{
			type: "toolCall" as const,
			id: "later-eval",
			name: "eval",
			arguments: { language: "js", code: 'display("REAL_EVAL_DONE")', timeout: 30 },
		},
	];
	const release = Promise.withResolvers<void>();
	const done = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	const errors: string[] = [];
	const factory = renderWorkflow.createRenderWorkflow;
	vi.spyOn(renderWorkflow, "createRenderWorkflow").mockImplementation((...args) => {
		const workflow = factory(...args);
		let sent = false;
		workflow.next = async () => {
			if (sent) return undefined;
			sent = true;
			return { calls, introduction: false, repetition: 1 };
		};
		const read = workflow.tools.find(tool => tool.name === "read")!;
		const executeRead = read.execute.bind(read);
		vi.spyOn(read, "execute").mockImplementation(async (...executeArgs) => {
			if (executeArgs[0] === "later-read") await release.promise;
			return executeRead(...executeArgs);
		});
		const evalTool = workflow.tools.find(tool => tool.name === "eval")!;
		const executeEval = evalTool.execute.bind(evalTool);
		vi.spyOn(evalTool, "execute").mockImplementation(async (...executeArgs) => {
			await release.promise;
			return executeEval(...executeArgs);
		});
		return workflow;
	});
	const stop = session.subscribe(event => {
		if (event.type !== "tool_execution_end") return;
		const index = calls.findIndex(call => call.id === event.toolCallId);
		if (event.isError) errors.push(event.toolCallId);
		if (index < 2) done[index]?.resolve();
	});
	const running = session.runRenderTest({ repeat: 1, delayMs: 1 }, mode.getToolUIContext());
	try {
		await Promise.all(done.map(barrier => barrier.promise));
		await terminal.waitForRender(
			() =>
				!mode.pendingTools.has("real-read") &&
				terminal.getScrollBuffer().slice(0, -terminal.rows).join("\n").includes("REAL_READ_079"),
		);
		expect(errors).toEqual([]);
		expect(session.isStreaming).toBeTrue();
		const history = terminal
			.getScrollBuffer()
			.slice(0, -terminal.rows)
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(Array.from(history.matchAll(/REAL_READ_\d{3}/g), match => match[0])).toEqual(readRows);
		expect(history).toContain("REAL_BASH_DONE");
		expect(history.indexOf("REAL_BASH_DONE")).toBeLessThan(history.indexOf("REAL_READ_000"));
		expect(mode.pendingTools.has("later-read")).toBeTrue();
		expect(mode.pendingTools.has("later-eval")).toBeTrue();
		mode.rebuildChatFromMessages();
		mode.ui.renderNow();
		await terminal.waitForRender();
		expect(
			Array.from(
				terminal
					.getScrollBuffer()
					.join("\n")
					.matchAll(/REAL_READ_\d{3}/g),
				match => match[0],
			),
		).toEqual(readRows);
		expect(mode.pendingTools.has("later-read")).toBeTrue();
		expect(mode.pendingTools.has("later-eval")).toBeTrue();
	} finally {
		release.resolve();
		try {
			await running;
		} finally {
			stop();
		}
	}
}, 60000);

it("preserves the failed edit and prior rows when the next assistant message begins", async () => {
	terminal.resize(110, 20);
	mode.setToolsExpanded(true);
	const afterError = Promise.withResolvers<void>();
	const continueStream = Promise.withResolvers<void>();
	const failed = Promise.withResolvers<void>();
	let errorText = "";
	const factory = renderWorkflow.createRenderWorkflow;
	vi.spyOn(renderWorkflow, "createRenderWorkflow").mockImplementation((...args) => {
		const workflow = factory(...args);
		const next = workflow.next.bind(workflow);
		workflow.next = async context => {
			const step = await next(context);
			if (!step) {
				afterError.resolve();
				await continueStream.promise;
			}
			return step;
		};
		return workflow;
	});
	const stop = session.subscribe(event => {
		if (event.type === "tool_execution_end" && event.toolName === "edit" && event.isError) {
			errorText = (event.result.content as ToolResultMessage["content"])
				.flatMap(block => (block.type === "text" ? [block.text] : []))
				.join("\n");
			failed.resolve();
		}
	});
	const running = session.runRenderTest({ repeat: 1, delayMs: 1, scenario: "edit-error" }, mode.getToolUIContext());
	const sourceRows = () =>
		Array.from(
			terminal
				.getScrollBuffer()
				.join("\n")
				.matchAll(/Fixture 2, row \d+:/g),
			match => match[0],
		);
	try {
		await Promise.all([afterError.promise, failed.promise]);
		await terminal.waitForRender();
		const before = sourceRows();
		expect(errorText).toContain("lines");
		expect(before).toEqual(Array.from({ length: 64 }, (_, row) => "Fixture 2, row " + (row + 1) + ":"));
		continueStream.resolve();
		await running;
		await session.waitForIdle();
		await terminal.waitForRender();
		expect(sourceRows()).toEqual(before);
		expect(terminal.getScrollBuffer().join("\n")).toContain("Streaming 3");
		const rows = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
		let bands = 0;
		for (let index = 1; index < rows.length; index++) {
			if (rows[index] !== "") continue;
			let end = index;
			while (end < rows.length && rows[end] === "") end++;
			if (end - index >= 3 && end < rows.length) bands++;
			index = end;
		}
		expect(bands).toBe(0);
	} finally {
		continueStream.resolve();
		try {
			await running;
		} finally {
			stop();
		}
	}
}, 60000);

it("restores bottom-anchored chat after the TODO scenario dismisses its completed panel", async () => {
	cfgTasksTodoClearDelay.override(session.settings, 4);
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

it.each([
	{ name: "answer", key: "\r", steps: ["STEP_1", "STEP_2"] },
	{ name: "cancel", key: "\x1b", steps: ["STEP_1"] },
])(
	"closing the ask by $name does not leave dialog-sized blank rows in history",
	async ({ key, steps }) => {
		const question = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "tool_execution_start" && event.toolName === "ask") question.resolve();
		});
		try {
			const running = session.runRenderTest({ repeat: 1, delayMs: 1, scenario: "ask" }, mode.getToolUIContext());
			await question.promise;
			await terminal.waitForRender(() => mode.ui.getFocused() instanceof AskDialogComponent);
			expect(mode.ui.getFocused()).toBeInstanceOf(AskDialogComponent);
			expect(terminal.getViewport().some(row => row.includes("select") && row.includes("cancel"))).toBeTrue();
			terminal.sendInput(key);
			await running;
			await session.waitForIdle();
			for (let frame = 0; frame < 3; frame++) {
				mode.ui.renderNow();
				await terminal.waitForRender();
				const tape = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
				let blankBands = 0;
				for (let index = 1; index < tape.length; index++) {
					if (tape[index] !== "") continue;
					let end = index;
					while (end < tape.length && tape[end] === "") end++;
					if (end - index >= 3 && end < tape.length) blankBands++;
					index = end;
				}
				expect(blankBands).toBe(0);
				expect(Array.from(tape.join("\n").matchAll(/STEP_\d+/g), match => match[0])).toEqual([...steps]);
			}
		} finally {
			unsubscribe();
		}
	},
	60_000,
);

it("keeps a very long ask clipped and uncommitted until every answer is submitted", async () => {
	terminal.resize(110, 40);
	const questions = [1, 2].map(index => ({
		id: `long-${index}`,
		question: Array.from({ length: 120 }, (_, row) => `LONG_Q${index}_${String(row).padStart(3, "0")}`).join("\n\n"),
		options: [{ label: "Continue" }, { label: "Revise" }],
		recommended: 0,
	}));
	const createWorkflow = renderWorkflow.createRenderWorkflow;
	vi.spyOn(renderWorkflow, "createRenderWorkflow").mockImplementation((...args) => {
		const workflow = createWorkflow(...args);
		const next = workflow.next.bind(workflow);
		workflow.next = async context => {
			const step = await next(context);
			for (const call of step?.calls ?? []) {
				if (call.name === "ask") call.arguments = { questions };
			}
			return step;
		};
		return workflow;
	});
	let assistantEnded = false;
	let askResults = 0;
	const questionReady = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "message_end" && event.message.role === "assistant") assistantEnded = true;
		if (event.type === "tool_execution_start" && event.toolName === "ask") questionReady.resolve();
		if (event.type === "tool_execution_end" && event.toolName === "ask") askResults++;
	});
	const checkPending = async () => {
		mode.ui.renderNow();
		await terminal.waitForRender();
		expect(mode.ui.getFocused()).toBeInstanceOf(AskDialogComponent);
		expect(assistantEnded).toBeTrue();
		expect(askResults).toBe(0);
		const viewport = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(viewport.some(row => row.includes("earlier lines"))).toBeTrue();
		const history = terminal
			.getScrollBuffer()
			.slice(0, -terminal.rows)
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(Array.from(history.matchAll(/LONG_Q[12]_\d{3}/g))).toEqual([]);
	};
	try {
		const running = session.runRenderTest({ repeat: 1, delayMs: 1, scenario: "ask" }, mode.getToolUIContext());
		await questionReady.promise;
		await terminal.waitForRender(() => mode.ui.getFocused() instanceof AskDialogComponent);
		await checkPending();
		terminal.sendInput("\r");
		await checkPending();
		expect(
			terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.join("\n"),
		).toContain("LONG_Q2_000");
		terminal.sendInput("\r");
		await checkPending();
		terminal.sendInput("\r");
		await running;
		await session.waitForIdle();
		mode.ui.renderNow();
		await terminal.waitForRender();
		expect(askResults).toBe(1);
		const tape = terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(Array.from(tape.matchAll(/LONG_Q[12]_\d{3}/g), match => match[0])).toEqual(
			[1, 2].flatMap(index =>
				Array.from({ length: 120 }, (_, row) => `LONG_Q${index}_${String(row).padStart(3, "0")}`),
			),
		);
		expect(terminal.getViewport().some(row => row.includes("earlier lines"))).toBeFalse();
	} finally {
		unsubscribe();
	}
}, 60_000);

it.each([
	{ toolName: "bash", preview: "collapsed", expanded: false, overlay: false },
	{ toolName: "eval", preview: "collapsed", expanded: false, overlay: false },
	{ toolName: "bash", preview: "expanded", expanded: true, overlay: false },
	{ toolName: "eval", preview: "expanded", expanded: true, overlay: false },
	{ toolName: "bash", preview: "collapsed", expanded: false, overlay: true },
	{ toolName: "eval", preview: "collapsed", expanded: false, overlay: true },
	{ toolName: "bash", preview: "expanded", expanded: true, overlay: true },
	{ toolName: "eval", preview: "expanded", expanded: true, overlay: true },
] as const)(
	"large $toolName argument streams retain the overflow marker in $preview preview (overlay=$overlay)",
	async ({ toolName, expanded, overlay }) => {
		terminal.resize(110, 40);
		if (expanded) terminal.sendInput("\x0f");
		const source = Array.from(
			{ length: 1200 },
			(_, row) => `${toolName === "eval" ? "//" : "#"} SOURCE_${row + 1}`,
		).join("\n");
		const createWorkflow = renderWorkflow.createRenderWorkflow;
		vi.spyOn(renderWorkflow, "createRenderWorkflow").mockImplementation((...args) => {
			const workflow = createWorkflow(...args);
			const next = workflow.next.bind(workflow);
			workflow.next = async context => {
				const step = await next(context);
				for (const call of step?.calls ?? []) {
					if (call.name !== "eval") continue;
					call.name = toolName;
					call.arguments =
						toolName === "eval"
							? { language: "js", title: "large preview", code: source + "\ndisplay(1)", timeout: 30 }
							: { command: source + "\nprintf done", timeout: 30 };
				}
				return step;
			};
			return workflow;
		});
		// Model the provider raw-JSON carrier, not a complete argument object
		// advertised from the first scripted delta.
		const partialInputs = new Map<string, string>();
		const emit = session.agent.emitExternalEvent.bind(session.agent);
		vi.spyOn(session.agent, "emitExternalEvent").mockImplementation(event => {
			if (event.type === "message_update") {
				const update = event.assistantMessageEvent;
				if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
					const block = update.partial.content[update.contentIndex];
					if (block?.type === "toolCall") {
						if (update.type === "toolcall_start") {
							const preview = { ...block, arguments: {} };
							setStreamingPartialJson(preview, "");
							update.partial.content[update.contentIndex] = preview;
						} else {
							const json = (partialInputs.get(block.id) ?? "") + update.delta;
							partialInputs.set(block.id, json);
							block.arguments = parseStreamingJson(json);
							setStreamingPartialJson(block, json);
						}
					}
				}
			}
			emit(event);
		});
		let sourceProgress = 0;
		let pending = true;
		let hideOverlay: (() => void) | undefined;
		let overlayClosed = !overlay;
		let observedCard: ToolExecutionComponent | undefined;
		let allocation: number | undefined;
		let renderedRows = 0;
		let decodedRows = 0;
		// Measure the snapshot used to build the current card, not newer args
		// still waiting in the stream-rebuild debounce.
		const renderer = toolRenderers[toolName];
		const renderCall = renderer.renderCall.bind(renderer);
		vi.spyOn(renderer, "renderCall").mockImplementation((args, options, theme) => {
			if (args && typeof args === "object") {
				const code = (args as Record<string, unknown>)[toolName === "eval" ? "code" : "command"];
				decodedRows = typeof code === "string" ? code.split("\n").length : 0;
			}
			return renderCall(args, options, theme);
		});
		const paints: Array<{
			progress: number;
			decodedRows: number;
			allocation: number | undefined;
			renderedRows: number;
			codeRows: number;
			marker: boolean;
		}> = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "tool_execution_start" && event.toolName === toolName) pending = false;
			if (event.type !== "message_update" || event.assistantMessageEvent.type !== "toolcall_delta") return;
			for (const match of event.assistantMessageEvent.delta.matchAll(/SOURCE_(\d+)/g)) {
				sourceProgress = Math.max(sourceProgress, Number(match[1]));
			}
			if (!observedCard) {
				const component = [...mode.pendingTools.values()].find(value => value instanceof ToolExecutionComponent);
				if (component instanceof ToolExecutionComponent) {
					observedCard = component;
					const allocate = component.setTranscriptAllocation.bind(component);
					const render = component.render.bind(component);
					vi.spyOn(component, "setTranscriptAllocation").mockImplementation((rows, frame) => {
						allocation = rows;
						allocate(rows, frame);
					});
					vi.spyOn(component, "render").mockImplementation(width => {
						const rows = render(width);
						renderedRows = rows.length;
						return rows;
					});
				}
			}
			if (sourceProgress > 64 && !hideOverlay && !overlayClosed) {
				const handle = mode.ui.showOverlay(new Text("Fullscreen rendering fixture", 0, 0), {
					fullscreen: true,
					width: "100%",
					maxHeight: "100%",
				});
				hideOverlay = () => handle.hide();
			}
			if (sourceProgress > 500 && hideOverlay) {
				hideOverlay();
				hideOverlay = undefined;
				overlayClosed = true;
			}
		});
		const stopPaints = mode.ui.addPaintListener(paint => {
			if (!pending || decodedRows <= terminal.rows || !overlayClosed || paint.alt || mode.ui.hasOverlay()) return;
			const viewport = terminal.getViewport().map(row => Bun.stripANSI(row));
			paints.push({
				progress: sourceProgress,
				decodedRows,
				allocation,
				renderedRows,
				codeRows: viewport.filter(row => row.includes("SOURCE_")).length,
				marker: viewport.some(row => row.includes("earlier lines")),
			});
		});
		try {
			await session.runRenderTest({ repeat: 1, delayMs: 20, scenario: "eval", segment: 2 }, mode.getToolUIContext());
			await session.waitForIdle();
			expect(paints.length).toBeGreaterThan(0);
			expect(paints.filter(paint => paint.codeRows === 0 || !paint.marker)).toEqual([]);
		} finally {
			unsubscribe();
			stopPaints();
			hideOverlay?.();
		}
	},
	60_000,
);

it.each(["ask", "job", "markdown", "eval"] as const)(
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
				await terminal.waitForRender(() => mode.ui.getFocused() instanceof AskDialogComponent);
				expect(mode.ui.getFocused()).toBeInstanceOf(AskDialogComponent);
				terminal.sendInput("\r");
			}
			await running;
			await session.waitForIdle();
			if (scenario === "ask") expect(calls).toEqual(["ask"]);
			else if (scenario === "job")
				expect(calls).toEqual([...Array<string>(11).fill("bash"), ...Array<string>(4).fill("hub")]);
			else if (scenario === "eval") expect(calls).toEqual(["eval", "eval", "eval"]);
			else {
				expect(calls).toEqual([]);
				const body = output.join("").split("\n");
				const markers = body.filter(line => line.startsWith("MARKDOWN_"));
				expect(markers).toHaveLength(50);
				expect(markers.map(line => line.slice(0, 11))).toEqual(
					Array.from({ length: 50 }, (_, index) => `MARKDOWN_${String(index + 1).padStart(2, "0")}`),
				);
				mode.ui.renderNow();
				await terminal.waitForRender();
				const tape = terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row))
					.join("\n");
				expect(Array.from(tape.matchAll(/MARKDOWN_\d+/g), match => match[0])).toEqual(
					markers.map(line => line.slice(0, 11)),
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
it.each(["large-edit", "edit-error", "advisor"] as const)(
	"runs the %s shrink-reproduction scenario without provider access",
	async scenario => {
		const events: string[] = [];
		const unsubscribe = session.subscribe(event => {
			if (event.type === "tool_execution_start") events.push(event.toolName);
			if (event.type === "message_start" && event.message.role === "custom") events.push(event.message.customType);
		});
		try {
			await session.runRenderTest({ repeat: 1, delayMs: 1, scenario }, mode.getToolUIContext());
			await session.waitForIdle();
			if (scenario === "advisor") {
				expect(events).toEqual(["advisor"]);
				expect(
					session.agent.state.messages.some(
						message => message.role === "custom" && message.customType === "advisor",
					),
				).toBeFalse();
			} else {
				expect(events).toContain("edit");
				expect(events).toContain("read");
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
				// TranscriptContainer.#renderViewport (packages/tui/src/chrome/transcript-container.ts)
				// deliberately emits one live-block separator; >=2 is a dead band.
				if (next < rows.length && next - index > 2 && rows[next] !== "") {
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

it.each([20, 40, 100])(
	"runs complete workflows in a %i-row terminal through real tools without provider calls",
	async rows => {
		terminal.resize(110, rows);
		mode.ui.requestRender(true);
		await terminal.waitForRender();
		const duplicateFrames: string[] = [];
		const splitCards: string[] = [];
		const scrollbackHoles: string[] = [];
		const write = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			write(data);
			const paintedRows = terminal
				.getScrollBuffer()
				.slice(-200)
				.map(row => Bun.stripANSI(row).trimEnd());
			const surface = [...terminal.getScrollBuffer(), ...terminal.getViewport()].map(row =>
				Bun.stripANSI(row).trimEnd(),
			);
			for (let index = 0; index < surface.length - 2; index++) {
				if (surface[index] === "" || surface[index + 1] !== "") continue;
				let next = index + 1;
				while (next < surface.length && surface[next] === "") next++;
				if (next < surface.length && next - index > 2)
					scrollbackHoles.push(surface.slice(Math.max(0, index - 1), next + 2).join("\n"));
			}
			for (let index = 1; index < paintedRows.length - 1; index++) {
				if (paintedRows[index] !== "" || !/^[│├╭]/.test(paintedRows[index - 1]!)) continue;
				let next = index + 1;
				while (paintedRows[next] === "") next++;
				// packages/tui/src/chrome/transcript-container.ts#renderViewport
				// emits exactly one separator row before a non-first live block;
				// two or more are dead allocator rows.
				if (next - index > 2 && /^[│├╰]/.test(paintedRows[next] ?? "")) {
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
		const advisorNotes: Array<{ note: string; severity?: string }> = [];
		const questions = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const streamingStarted = Promise.withResolvers<void>();
		const transientIrc = Promise.withResolvers<void>();
		const rebuildTransientIrc = transientIrc.promise.then(async () => {
			await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("Temporary IRC card 5")));
			mode.rebuildChatFromMessages();
			await terminal.waitForRender();
		});
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
			if (event.type === "irc_message" && event.message.customType === "irc:incoming") transientIrc.resolve();
			if (
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === "advisor"
			) {
				advisorNotes.push(
					...((event.message.details as { notes?: Array<{ note: string; severity?: string }> } | undefined)
						?.notes ?? []),
				);
			}
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
			await terminal.waitForRender(() => mode.ui.getFocused() instanceof AskDialogComponent);
			expect(mode.ui.getFocused()).toBeInstanceOf(AskDialogComponent);
			const count = assistantStarts;
			await Bun.sleep(100);
			expect(assistantStarts).toBe(count);
			expect(questionCount).toBe(repetition + 1);
			expect(session.isStreaming).toBeTrue();
			terminal.sendInput("\r");
		}
		await rebuildTransientIrc;
		await running;
		await session.waitForIdle();
		mode.ui.renderNow();
		await terminal.waitForRender();
		expect(session.isStreaming).toBeFalse();
		expect(runStates).toEqual(["running", "idle"]);
		expect(session.getTodoPhases()).toEqual(savedTodo);
		expect(duplicateFrames).toEqual([]);
		expect(splitCards).toEqual([]);
		expect(scrollbackHoles).toEqual([]);
		expect(thinkingDeltas).toBeGreaterThan(2);
		expect(textDeltas).toBeGreaterThan(100);
		expect(results.filter(result => result.toolName === "write" && !result.isError)).toHaveLength(2);
		expect(results.filter(result => result.toolName === "read")).toHaveLength(20);
		const edits = results.filter(result => result.toolName === "edit");
		expect(edits).toHaveLength(10);
		expect(edits.filter(result => result.isError)).toHaveLength(2);
		for (const error of edits.filter(result => result.isError)) {
			expect(
				error.content
					.filter(block => block.type === "text")
					.map(block => block.text)
					.join("\n"),
			).toMatch(/snapshot|hash|stale|line|range|bound|outside/i);
		}
		expect(results.filter(result => result.toolName === "ask" && !result.isError)).toHaveLength(2);
		expect(results.filter(result => result.toolName === "bash" && !result.isError)).toHaveLength(22);
		expect(results.filter(result => result.toolName === "hub" && !result.isError)).toHaveLength(8);
		for (const repetition of [1, 2]) {
			const calls = assistants
				.filter(message =>
					message.content.some(
						block => block.type === "toolCall" && block.id.startsWith(`render-workflow-${repetition}-`),
					),
				)
				.flatMap(message => message.content.filter(block => block.type === "toolCall"));
			expect(calls.filter(call => call.name === "write")).toHaveLength(1);
			expect(calls.filter(call => call.name === "edit")).toHaveLength(5);
		}
		expect(advisorNotes).toHaveLength(4);
		expect(advisorNotes.map(note => note.severity)).toEqual(["concern", "warning", "blocker", "concern"]);
		expect(
			session.agent.state.messages.some(message => message.role === "custom" && message.customType === "advisor"),
		).toBeFalse();
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
		const firstReads = tape.slice(tape.indexOf("Streaming 3 — BEGIN"), tape.indexOf("Streaming 4 — BEGIN"));
		for (const file of [1, 2]) {
			expect(firstReads).toContain(`Fixture ${file}, row 1:`);
			expect(firstReads).toContain(`Fixture ${file}, row 3:`);
		}
		expect(firstReads).toContain("Generated write fixture row 1:");
		expect(firstReads).toContain("Generated write fixture row 3:");
		// Two repetitions of the Markdown introduction: 10 list, 10 table, 3 quote, 15 code rows each.
		expect(expected.filter(marker => marker.startsWith("LIST_"))).toHaveLength(20);
		expect(expected.filter(marker => marker.startsWith("TABLE_"))).toHaveLength(20);
		expect(expected.filter(marker => marker.startsWith("CODE_"))).toHaveLength(30);
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
