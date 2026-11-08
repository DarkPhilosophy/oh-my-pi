/** Exercise transcript ownership across mid-run rebuilds and late tool results. */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Call = [id: string, name: string, args: Record<string, unknown>];

function assistantCalls(calls: Call[]): AgentMessage {
	return {
		role: "assistant",
		content: calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

function toolResult(id: string, name: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		details: {},
		isError: false,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

let tempDir: TempDir;
let mode: InteractiveMode;
let history: AgentMessage[] = [];

beforeEach(async () => {
	tempDir = TempDir.createSync("@pi-compaction-rebuild-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const session = {
		subscribe: () => () => {},
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		agent: {
			state: { tools: [], streamMessage: null, isStreaming: true },
			metadataForProvider: () => undefined,
			getPendingToolResults: () => [],
		},
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
		isStreaming: true,
		retryAttempt: 0,
		isRetrying: false,
		getToolByName: () => undefined,
		hasBuiltInTool: () => true,
		buildTranscriptSessionContext: () => ({ messages: history }) as unknown as SessionContext,
		getAsyncJobSnapshot: () => ({ running: [] }),
		activeToolExecutionUpdates: () => [],
		enableIdleMaintenance: () => {},
		refreshIdleMaintenance: () => {},
	} as unknown as AgentSession;
	mode = new InteractiveMode(session, "test");
	// Only the transcript rebuild path is under test, not the full UI init().
	mode.isInitialized = true;
});

afterEach(() => {
	mode?.stop();
	tempDir?.removeSync();
	resetSettingsForTest();
});

function unfinalized(): string[] {
	return mode.chatContainer.children
		.filter(child => (child as { isTranscriptBlockFinalized?(): boolean }).isTranscriptBlockFinalized?.() === false)
		.map(child => child.constructor.name);
}

async function finish(calls: Call[]): Promise<void> {
	for (const [id, name] of calls) {
		await mode.eventController.handleEvent({
			type: "tool_execution_end",
			toolCallId: id,
			toolName: name,
			result: { content: [{ type: "text", text: "ok" }], details: {} },
			isError: false,
		});
	}
}

describe("automatic-compaction rebuild with tools still running", () => {
	const calls: Call[] = [
		["p1", "grep", { pattern: "a", path: "." }],
		["p2", "bash", { command: "sleep 5" }],
		["p3", "read", { path: "a.ts" }],
		["p4", "read", { path: "b.ts" }],
	];

	for (const landedBefore of [0, 1, 2]) {
		it(`leaves no unfinalized block when the turn ends (${landedBefore} landed before the rebuild)`, async () => {
			mode.chatContainer.disposeChildren();
			const landed = calls.slice(0, landedBefore);
			history = [assistantCalls(calls), ...landed.map(([id, name]) => toolResult(id, name))];

			for (const [id, name, args] of calls) {
				await mode.eventController.handleEvent({
					type: "tool_execution_start",
					toolCallId: id,
					toolName: name,
					args,
				});
			}
			await finish(landed);
			mode.rebuildChatFromMessages({ reuseSettledComponents: true });
			await finish(calls.slice(landedBefore));

			// The turn ends exactly as it would without a rebuild: nothing may stay live.
			const session = mode.session as unknown as { isStreaming: boolean };
			session.isStreaming = false;
			await mode.eventController.handleEvent({ type: "agent_end", messages: [], isTerminal: true } as never);
			session.isStreaming = true;
			expect(unfinalized()).toEqual([]);
		});
	}
});

describe("eval with streamed partial frames", () => {
	for (const rebuildBetween of [false, true]) {
		it(`retires an eval after its partial frames and final result (rebuild between: ${rebuildBetween})`, async () => {
			mode.chatContainer.disposeChildren();
			const args = { code: "print(1)" };
			history = [assistantCalls([["e1", "eval", args]])];
			const ev = mode.eventController;

			await ev.handleEvent({ type: "tool_execution_start", toolCallId: "e1", toolName: "eval", args });
			await ev.handleEvent({
				type: "tool_execution_update",
				toolCallId: "e1",
				toolName: "eval",
				args,
				partialResult: { content: [{ type: "text", text: "1" }], details: {} },
			} as never);
			if (rebuildBetween) mode.rebuildChatFromMessages({ reuseSettledComponents: true });
			await ev.handleEvent({
				type: "tool_execution_end",
				toolCallId: "e1",
				toolName: "eval",
				result: { content: [{ type: "text", text: "1" }], details: {} },
				isError: false,
			});
			expect(unfinalized()).toEqual([]);
		});
	}
});

describe("viewport with many real tool cards", () => {
	for (const rows of [12, 24, 38]) {
		it(`shows the newest results, not a header per card (${rows} rows)`, async () => {
			mode.chatContainer.disposeChildren();
			const ev = mode.eventController;
			// A call still running at the head keeps every finished card behind it live.
			await ev.handleEvent({
				type: "tool_execution_start",
				toolCallId: "head",
				toolName: "eval",
				args: { language: "py", title: "still running", code: "wait_for_it()" },
			});
			for (let i = 0; i < 30; i++) {
				const id = `m${i}`;
				const args = { language: "py", title: `step ${i}`, code: `compute_${i}()` };
				await ev.handleEvent({ type: "tool_execution_start", toolCallId: id, toolName: "eval", args });
				await ev.handleEvent({
					type: "tool_execution_end",
					toolCallId: id,
					toolName: "eval",
					result: { content: [{ type: "text", text: `OUT_MARK_${i}` }], details: {} },
					isError: false,
				});
			}
			const shown = mode.chatContainer
				.renderViewport(100, rows, { tick: 0, now: 0 })
				.map(row => Bun.stripANSI(row).trim());
			expect(shown.length).toBeLessThanOrEqual(rows);
			// The last result is on screen, with its context, instead of thirty identical headers.
			expect(shown.some(row => row.includes("OUT_MARK_29"))).toBe(true);
			expect(shown.filter(row => row === "• eval").length).toBe(0);
		});
	}
});

describe("completion received before its result is available to transcript replay", () => {
	for (const name of ["eval", "bash"] as const) {
		it(`${name}: rebuild consumes the buffered result without waiting for agent_end`, async () => {
			const id = "completed-before-rebuild";
			const args = name === "eval" ? { code: "compute()" } : { command: "compute-result" };
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId: id,
				toolName: name,
				content: [{ type: "text", text: "RESULT_AFTER_REBUILD" }],
				details: {},
				isError: false,
				timestamp: Date.now(),
			};
			history = [assistantCalls([[id, name, args]])];
			await mode.eventController.handleEvent({ type: "tool_execution_start", toolCallId: id, toolName: name, args });
			await mode.eventController.handleEvent({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: name,
				result: { content: result.content, details: result.details },
				isError: false,
			});
			const pending = vi.spyOn(mode.session.agent, "getPendingToolResults").mockReturnValue([result]);
			try {
				mode.rebuildChatFromMessages({ reuseSettledComponents: true });
				expect(mode.pendingTools.has(id)).toBe(false);
				const historyRows: string[] = [];
				for (let step = 0; step < 20; step++) {
					const batch = mode.chatContainer.peekFinalizedBatch(100, 12);
					if (!batch) break;
					historyRows.push(...batch.rows);
					mode.chatContainer.acknowledgeFinalizedBatch(batch.id);
				}
				await mode.eventController.handleEvent({
					type: "tool_execution_end",
					toolCallId: id,
					toolName: name,
					result: { content: result.content, details: result.details },
					isError: false,
				});
				const viewport = mode.chatContainer.renderViewport(100, 12, { tick: 0, now: 0 });
				const rendered = Bun.stripANSI([...historyRows, ...viewport].join("\n"));
				expect(rendered.split("RESULT_AFTER_REBUILD").length - 1).toBe(1);
			} finally {
				pending.mockRestore();
			}
		});
	}
});

describe("thinking interrupted before message_end", () => {
	it("closes the abandoned thought at agent_end so later output can retire", async () => {
		const message = {
			...assistantCalls([]),
			content: [{ type: "thinking", thinking: "ABANDONED_THOUGHT" }],
			stopReason: "stop",
		} as AgentMessage;
		await mode.eventController.handleEvent({ type: "message_start", message });
		const thinking = mode.streamingComponent!;
		expect(thinking.isTranscriptBlockFinalized()).toBe(false);
		(mode.session as unknown as { isStreaming: boolean }).isStreaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [], isTerminal: true } as never);
		expect(unfinalized()).toEqual([]);
		expect(mode.streamingComponent).toBeUndefined();
		expect(mode.streamingMessage).toBeUndefined();
		await mode.eventController.handleEvent({
			type: "tool_execution_start",
			toolCallId: "after-thought",
			toolName: "bash",
			args: { command: "produce-output" },
		});
		await mode.eventController.handleEvent({
			type: "tool_execution_end",
			toolCallId: "after-thought",
			toolName: "bash",
			result: { content: [{ type: "text", text: "OUTPUT_AFTER_THOUGHT" }], details: {} },
			isError: false,
		});
		const retired: string[] = [];
		for (let step = 0; step < 10; step++) {
			const batch = mode.chatContainer.peekFinalizedBatch(100, 0);
			if (!batch) break;
			retired.push(...batch.rows);
			mode.chatContainer.acknowledgeFinalizedBatch(batch.id);
		}
		expect(Bun.stripANSI(retired.join("\n"))).toContain("OUTPUT_AFTER_THOUGHT");
	});
});
