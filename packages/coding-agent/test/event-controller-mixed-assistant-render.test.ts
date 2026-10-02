import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage, Usage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import {
	chatTranscriptDisplayPreferences,
	setChatTranscriptDisplayPreferences,
} from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { cfgReadGroupAcrossStreams, cfgReadToolResultPreview } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { type Component, Text, type TUI, TERMINAL } from "@oh-my-pi/pi-tui";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";

import { cfgTerminalShowImages } from "@oh-my-pi/pi-coding-agent/modes/settings";

const TOOL_CALL_A_ID = "toolu_mixed_text_order_a";
const TOOL_CALL_B_ID = "toolu_mixed_text_order_b";
const INTRO_MARKER = "INTRO TEXT BEFORE FIRST TOOL";
const TOOL_RESULT_A_MARKER = "TOOL RESULT FROM FIRST TOOL";
const MIDDLE_MARKER = "MIDDLE TEXT BETWEEN TOOL CALLS";
const TOOL_RESULT_B_MARKER = "TOOL RESULT FROM SECOND TOOL";
const FINAL_MARKER = "FINAL ANSWER AFTER SECOND TOOL";
const HIDDEN_BASH_COMMAND_MARKER = "HIDDEN BASH COMMAND MARKER";
const HIDDEN_BASH_FAILURE_MARKER = "HIDDEN BASH FAILURE MARKER";
const HIDDEN_READ_PATH_MARKER = "hidden-tool-activity.ts";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor",
		provider: "cursor",
		model: "cursor-model",
		stopReason: "stop",
		usage: zeroUsage(),
		timestamp: 1,
	};
}

function lineContaining(lines: string[], marker: string): number {
	const index = lines.findIndex(line => line.includes(marker));
	if (index === -1) {
		throw new Error(`Rendered transcript did not contain ${marker}:\n${lines.join("\n")}`);
	}
	return index;
}

function createFixture(
	hideToolActivity = false,
	toolByName: (name: string) => AgentTool | undefined = () => undefined,
	isStreaming = false,
	ui?: TUI,
) {
	let hasDisplayableThinkingContent = false;
	const ctx = createInteractiveModeContext({
		...(ui ? { ui } : {}),
		session: { getToolByName: toolByName, isStreaming },
		hideToolActivity,
		noteDisplayableThinkingContent: vi.fn((message: AssistantMessage) => {
			const hasThinking = message.content.some(
				content => content.type === "thinking" && content.thinking.trim() !== "",
			);
			if (!hasThinking || hasDisplayableThinkingContent) return false;
			hasDisplayableThinkingContent = true;
			return true;
		}),
		lastAssistantUsage: zeroUsage(),
	});
	ctx.chatContainer.setToolActivityVisible(!hideToolActivity);

	return { controller: new EventController(ctx), chatContainer: ctx.chatContainer, ctx };
}

describe("EventController mixed assistant text/tool rendering", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": false } });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("keeps finalized thinking distinct from the user-message background", () => {
		const component = new AssistantMessageComponent(
			assistantMessage([{ type: "thinking", thinking: "REASONING BLOCK" }]),
			false,
		);
		const rendered = component.render(120).join("\n");
		expect(rendered).toContain("REASONING BLOCK");
		expect(rendered).not.toContain("\x1b[48;");
	});

	it("appends a terminal task result without repainting its borrowed pending card", async () => {
		const { controller, ctx, chatContainer } = createFixture();
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "borrowed-task",
			toolName: "task",
			args: { agent: "task", tasks: [{ id: "Child", task: "Inspect the source" }] },
		});
		const pending = ctx.pendingTools.get("borrowed-task")!;
		chatContainer.renderViewport(120, 100, { tick: 0, now: 0 });
		chatContainer.setBorrowedViewportRows(1);
		const before = pending.render(120);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "borrowed-task",
			toolName: "task",
			result: { content: [{ type: "text", text: "VISIBLE TERMINAL TASK RESULT" }] },
			isError: false,
		});
		expect(pending.render(120)).toEqual(before);
		const text = Bun.stripANSI(chatContainer.renderViewport(120, 100, { tick: 0, now: 0 }).join("\n"));
		expect(text).toContain("VISIBLE TERMINAL TASK RESULT");
		expect(ctx.pendingTools.has("borrowed-task")).toBe(false);
	});

	it("finalizes and removes an orphaned streaming component on the next message_start", async () => {
		// Regression: a stream that died between message_start and message_end
		// (transport drop, hook throw) left its component live in the transcript.
		// One unfinalized block at the retirement frontier blocks history commits
		// for everything after it, so the whole transcript tail stayed in the
		// mutable viewport in pressure mode (no separators, compacted blocks).
		const { controller, chatContainer } = createFixture();

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: assistantMessage([{ type: "thinking", thinking: "**dead attempt**" }]),
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		const orphan = chatContainer.children.at(-1) as Component & {
			isTranscriptBlockFinalized(): boolean;
		};
		expect(orphan.isTranscriptBlockFinalized()).toBe(false);

		// Retry attempt streams a fresh message without the dead one ever ending.
		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);

		expect(chatContainer.children).not.toContain(orphan);
		expect(orphan.isTranscriptBlockFinalized()).toBe(true);
	});

	it.each([
		{ path: "live", crossStream: false },
		{ path: "rebuild", crossStream: false },
		{ path: "native", crossStream: false },
		{ path: "live", crossStream: true },
		{ path: "rebuild", crossStream: true },
		{ path: "native", crossStream: true },
	] as const)("honors cross-stream grouping $crossStream on the $path path", async ({ path, crossStream }) => {
		const { controller, chatContainer, ctx } = createFixture(false, () => undefined, true);
		cfgReadGroupAcrossStreams.override(ctx.settings, crossStream);
		const originalPreferences = { ...chatTranscriptDisplayPreferences };
		const releaseEffects = bindEffects(ctx.settings);
		const calls = Array.from({ length: 5 }, (_, response) =>
			Array.from({ length: response === 0 ? 4 : 1 }, (_, index): ToolCall => ({
				type: "toolCall",
				id: `response-${response}-read-${index}`,
				name: "read",
				arguments: { path: `response-${response}-${index}.txt` },
			})),
		);
		const messages = calls.map((content, response): AssistantMessage => ({
			...assistantMessage(content),
			usage: { ...zeroUsage(), input: response + 1, output: 1, totalTokens: response + 2 },
			timestamp: new Date(2026, 9, 3, 1, response, 0).getTime(),
		}));
		const persisted: Array<AssistantMessage | ToolResultMessage> = [];
		const resultFor = (call: ToolCall): ToolResultMessage => ({
			role: "toolResult",
			toolCallId: call.id,
			toolName: "read",
			content: [{ type: "text", text: `RESULT_${call.id}` }],
			isError: false,
			timestamp: 2,
		});
		for (const [response, message] of messages.entries()) {
			persisted.push(message);
			if (path === "live") {
				await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
				await controller.handleEvent({
					type: "message_update",
					message,
					assistantMessageEvent: {
						type: "toolcall_end",
						contentIndex: message.content.length - 1,
						toolCall: calls[response]!.at(-1)!,
						partial: message,
					},
				});
				await controller.handleEvent({ type: "message_end", message });
			}
			for (const call of calls[response]!) {
				if (response === 0 && call === calls[0]!.at(-1)) continue;
				const result = resultFor(call);
				persisted.push(result);
				if (path === "live")
					await controller.handleEvent({
						type: "tool_execution_end",
						toolCallId: call.id,
						toolName: "read",
						result,
						isError: false,
					});
			}
		}
		const lateCall = calls[0]!.at(-1)!;
		const lateResult = resultFor(lateCall);
		persisted.push(lateResult);
		let builder: ChatTranscriptBuilder | undefined;
		try {
			if (path === "live") {
				await controller.handleEvent({
					type: "tool_execution_end",
					toolCallId: lateCall.id,
					toolName: "read",
					result: lateResult,
					isError: false,
				});
			} else if (path === "rebuild") {
				const helpers = new UiHelpers(ctx);
				ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
				helpers.renderSessionContext({ messages: persisted } as SessionContext);
			} else {
				builder = new ChatTranscriptBuilder({ ui: ctx.ui, cwd: ".", requestRender: () => {} });
				builder.rebuild(
					persisted.map((message, index) => ({
						type: "message" as const,
						id: `entry-${index}`,
						parentId: null,
						timestamp: new Date(message.timestamp).toISOString(),
						message,
					})),
				);
			}
			const container = builder?.container ?? chatContainer;
			const groups = container.children.filter(
				(component): component is ReadToolGroupComponent => component instanceof ReadToolGroupComponent,
			);
			expect(groups).toHaveLength(crossStream ? 1 : 5);
			for (const [response, group] of groups.entries()) {
				for (const call of calls.flat())
					expect(group.hasToolCall(call.id)).toBe(crossStream || calls[response]!.includes(call));
				expect(Bun.stripANSI(group.render(120).join("\n"))).not.toContain("⏳");
			}
			const rendered = Bun.stripANSI(container.render(120).join("\n"));
			expect(rendered.match(crossStream ? /Read \(8\)/g : /Read \(4\)/g)).toHaveLength(1);
			expect(rendered).not.toContain(crossStream ? "Read (4)" : "Read (8)");
		} finally {
			builder?.dispose();
			for (const component of ctx.pendingTools.values()) component.seal();
			releaseEffects();
			setChatTranscriptDisplayPreferences(originalPreferences);
		}
	});

	it("applies grouping changes to the next response without losing existing pending reads", async () => {
		const { controller, ctx, chatContainer } = createFixture(false, () => undefined, true);
		const previous = cfgReadGroupAcrossStreams.get(ctx.settings);
		try {
			for (const [response, crossStream] of [true, false, true].entries()) {
				cfgReadGroupAcrossStreams.override(ctx.settings, crossStream);
				const calls: ToolCall[] = [0, 1].map(index => ({
					type: "toolCall",
					id: `switch-${response}-${index}`,
					name: "read",
					arguments: { path: `switch-${response}-${index}.txt` },
				}));
				const message = assistantMessage(calls);
				await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
				await controller.handleEvent({
					type: "message_update",
					message,
					assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: calls[1]!, partial: message },
				});
				await controller.handleEvent({ type: "message_end", message });
			}
			const groups = chatContainer.children.filter(
				(child): child is ReadToolGroupComponent => child instanceof ReadToolGroupComponent,
			);
			expect(groups).toHaveLength(3);
			for (const [response, group] of groups.entries()) {
				expect(ctx.pendingTools.get(`switch-${response}-0`)).toBe(group);
				expect(ctx.pendingTools.get(`switch-${response}-1`)).toBe(group);
			}
			for (const [callId] of Array.from(ctx.pendingTools)) {
				await controller.handleEvent({
					type: "tool_execution_end",
					toolCallId: callId,
					toolName: "read",
					result: { content: [{ type: "text", text: `RESULT_${callId}` }] },
					isError: false,
				});
			}
			expect(ctx.pendingTools.size).toBe(0);
			expect(Bun.stripANSI(chatContainer.render(120).join("\n")).match(/Read \(2\)/g)).toHaveLength(3);
		} finally {
			cfgReadGroupAcrossStreams.override(ctx.settings, previous);
			for (const component of ctx.pendingTools.values()) component.seal();
		}
	});

	it("renders assistant text segments in order around two tool results from one mixed message", async () => {
		const { controller, chatContainer } = createFixture();
		const toolCallA: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_A_ID,
			name: "contract_probe_a",
			arguments: { value: "a" },
		};
		const toolCallB: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_B_ID,
			name: "contract_probe_b",
			arguments: { value: "b" },
		};
		const started = assistantMessage([]);
		const withFirstToolCall = assistantMessage([{ type: "text", text: INTRO_MARKER }, toolCallA]);
		const withSecondToolCall = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			toolCallA,
			{ type: "text", text: MIDDLE_MARKER },
			toolCallB,
		]);
		const completed = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			toolCallA,
			{ type: "text", text: MIDDLE_MARKER },
			toolCallB,
			{ type: "text", text: FINAL_MARKER },
		]);

		await controller.handleEvent({ type: "message_start", message: started } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: withFirstToolCall,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 1,
				toolCall: toolCallA,
				partial: withFirstToolCall,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await controller.handleEvent({
			type: "message_update",
			message: withSecondToolCall,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 3,
				toolCall: toolCallB,
				partial: withSecondToolCall,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		const liveLines = chatContainer.render(120).map(line => Bun.stripANSI(line));
		expect(lineContaining(liveLines, INTRO_MARKER)).toBeLessThan(lineContaining(liveLines, MIDDLE_MARKER));
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "contract_probe_a",
			args: { value: "a" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "contract_probe_a",
			result: { content: [{ type: "text", text: TOOL_RESULT_A_MARKER }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "contract_probe_b",
			args: { value: "b" },
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "contract_probe_b",
			result: { content: [{ type: "text", text: TOOL_RESULT_B_MARKER }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({ type: "message_end", message: completed } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		const lines = chatContainer.render(120).map(line => Bun.stripANSI(line));
		const introLine = lineContaining(lines, INTRO_MARKER);
		const toolResultALine = lineContaining(lines, TOOL_RESULT_A_MARKER);
		const middleLine = lineContaining(lines, MIDDLE_MARKER);
		const toolResultBLine = lineContaining(lines, TOOL_RESULT_B_MARKER);
		const finalLine = lineContaining(lines, FINAL_MARKER);

		expect(introLine).toBeLessThan(toolResultALine);
		expect(toolResultALine).toBeLessThan(middleLine);
		expect(lines.filter(line => line.includes(MIDDLE_MARKER))).toHaveLength(1);
		expect(middleLine).toBeLessThan(toolResultBLine);
		expect(toolResultBLine).toBeLessThan(finalLine);
	});

	it("commits finished calls from a mixed batch before the assistant stream and later calls finish", async () => {
		const terminal = new VirtualTerminal(120, 14);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			preferences: { quiet: true },
			tuiOptions: { renderScheduler: scheduler },
		});
		const { controller, chatContainer, ctx } = createFixture(false, () => undefined, true, composer.ui);
		ctx.toolOutputExpanded = true;
		const previousPreview = cfgReadToolResultPreview.get(ctx.settings);
		cfgReadToolResultPreview.override(ctx.settings, true);
		const calls: ToolCall[] = [
			{ type: "toolCall", id: "mixed-bash", name: "bash", arguments: { command: "printf mixed" } },
			...[0, 1, 2].map(index => ({
				type: "toolCall" as const,
				id: `mixed-read-${index}`,
				name: "read",
				arguments: { path: `mixed-${index}.txt` },
			})),
			...[0, 1].map(index => ({
				type: "toolCall" as const,
				id: `mixed-eval-${index}`,
				name: "eval",
				arguments: { language: "js", code: "display(1)" },
			})),
		];
		composer.setRuntimeChildren([chatContainer, new Text("EDITOR", 0, 0)]);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
			const partial = assistantMessage([{ type: "text", text: INTRO_MARKER }, ...calls]);
			await controller.handleEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: calls.length,
					toolCall: calls.at(-1)!,
					partial,
				},
			});
			for (const call of calls)
				await controller.handleEvent({
					type: "tool_execution_start",
					toolCallId: call.id,
					toolName: call.name,
					args: call.arguments,
				});
			const finished: ToolResultMessage[] = [];
			for (const [index, call] of calls.slice(0, 2).entries()) {
				const text = Array.from(
					{ length: 40 },
					(_, row) => `MIXED_DONE_${index}_${String(row).padStart(2, "0")}`,
				).join("\n");
				finished.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text }],
					isError: false,
					timestamp: index + 2,
				});
				await controller.handleEvent({
					type: "tool_execution_end",
					toolCallId: call.id,
					toolName: call.name,
					result: { content: [{ type: "text", text }] },
					isError: false,
				});
			}
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			const history = terminal.getScrollBuffer().slice(0, -terminal.rows).join("\n");
			const outputs = Array.from(history.matchAll(/MIXED_DONE_[01]_\d{2}/g), match => match[0]);
			expect(outputs).toEqual(
				[0, 1].flatMap(index =>
					Array.from({ length: 40 }, (_, row) => `MIXED_DONE_${index}_${String(row).padStart(2, "0")}`),
				),
			);
			expect([...ctx.pendingTools.keys()]).toEqual(calls.slice(2).map(call => call.id));
			for (const component of ctx.pendingTools.values()) {
				expect(
					component instanceof ReadToolGroupComponent || component instanceof ToolExecutionComponent,
				).toBeTrue();
				if (component instanceof ReadToolGroupComponent || component instanceof ToolExecutionComponent)
					expect(component.isTranscriptBlockFinalized()).toBeFalse();
			}
			const tail = assistantMessage([...partial.content, { type: "text", text: "ASSISTANT STILL STREAMING" }]);
			await controller.handleEvent({
				type: "message_update",
				message: tail,
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: tail.content.length - 1,
					delta: "ASSISTANT STILL STREAMING",
					partial: tail,
				},
			});
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(
				Array.from(
					terminal
						.getScrollBuffer()
						.join("\n")
						.matchAll(/MIXED_DONE_[01]_\d{2}/g),
					match => match[0],
				),
			).toEqual(outputs);
			const helpers = new UiHelpers(ctx);
			ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
			ctx.eventController = controller;
			chatContainer.clear();
			helpers.renderSessionContext({ messages: [partial, ...finished] } as SessionContext);
			await scheduler.settle(terminal);
			expect(
				Array.from(
					terminal
						.getScrollBuffer()
						.join("\n")
						.matchAll(/MIXED_DONE_[01]_\d{2}/g),
					match => match[0],
				),
			).toEqual(outputs);
			for (const component of ctx.pendingTools.values()) {
				if (component instanceof ReadToolGroupComponent || component instanceof ToolExecutionComponent)
					expect(component.isTranscriptBlockFinalized()).toBeFalse();
			}
			for (const [index, call] of calls.slice(2).entries()) {
				const text = Array.from(
					{ length: 40 },
					(_, row) => `MIXED_DONE_${index + 2}_${String(row).padStart(2, "0")}`,
				).join("\n");
				await controller.handleEvent({
					type: "tool_execution_end",
					toolCallId: call.id,
					toolName: call.name,
					result: { content: [{ type: "text", text }] },
					isError: false,
				});
			}
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(
				Array.from(
					terminal
						.getScrollBuffer()
						.join("\n")
						.matchAll(/MIXED_DONE_[0-5]_\d{2}/g),
					match => match[0],
				),
			).toEqual(
				calls.flatMap((_, index) =>
					Array.from({ length: 40 }, (_, row) => `MIXED_DONE_${index}_${String(row).padStart(2, "0")}`),
				),
			);
		} finally {
			cfgReadToolResultPreview.override(ctx.settings, previousPreview);
			for (const component of ctx.pendingTools.values()) component.seal();
			composer.stop();
		}
	});

	it.each([12, 20, 30])("keeps the failed edit exactly once across a new streamed message at %s rows", async rows => {
		const terminal = new VirtualTerminal(100, rows);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			preferences: { quiet: true },
			tuiOptions: { renderScheduler: scheduler },
		});
		const { controller, chatContainer, ctx } = createFixture(false, () => undefined, true, composer.ui);
		for (let row = 0; row < 40; row++) chatContainer.addChild(new Text("PRE_EDIT_" + row, 0, 0));
		composer.setRuntimeChildren([chatContainer, new Text("EDITOR", 0, 0)]);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			const call: ToolCall = { type: "toolCall", id: "failed-edit", name: "edit", arguments: { input: "PATCH" } };
			const errorLines = Array.from(
				{ length: 18 },
				(_, row) =>
					`FAILED_EDIT_ROW_${String(row).padStart(2, "0")}: Verify the source anchor before applying this patch; the requested range was not displayed.`,
			);
			const message = assistantMessage([{ type: "text", text: "Editing" }, call]);
			await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
			await controller.handleEvent({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: call, partial: message },
			});
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: call.id,
				toolName: call.name,
				args: call.arguments,
			});
			const pending = ctx.pendingTools.get(call.id);
			if (!(pending instanceof ToolExecutionComponent)) throw new Error("Expected edit card");
			pending.updateStreamPreview({
				files: [
					{
						path: "sample.ts",
						diff: Array.from({ length: 40 }, (_, row) => "+" + (row + 1) + "| const value = 1;").join("\n"),
					},
				],
				streaming: false,
			});
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: call.id,
				toolName: call.name,
				result: { content: [{ type: "text", text: errorLines.join("\n") }] },
				isError: true,
			});
			await controller.handleEvent({ type: "message_end", message });
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
			const lines = Array.from({ length: 50 }, (_, row) => "AFTER_FAILED_EDIT_" + String(row).padStart(2, "0"));
			for (let count = 1; count <= lines.length; count++) {
				const text = lines.slice(0, count).join("\n\n");
				const continuation = assistantMessage([{ type: "text", text }]);
				await controller.handleEvent({
					type: "message_update",
					message: continuation,
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: lines[count - 1]!,
						partial: continuation,
					},
				});
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				const current = terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row))
					.join("\n");
				expect(Array.from(current.matchAll(/PRE_EDIT_\d+/g), match => match[0])).toEqual(
					Array.from({ length: 40 }, (_, row) => "PRE_EDIT_" + row),
				);
				expect(Array.from(current.matchAll(/FAILED_EDIT_ROW_\d{2}/g), match => match[0])).toEqual(
					errorLines.map((_, row) => `FAILED_EDIT_ROW_${String(row).padStart(2, "0")}`),
				);
				expect(Array.from(current.matchAll(/AFTER_FAILED_EDIT_\d{2}/g), match => match[0])).toEqual(
					lines.slice(0, count),
				);
			}
			const tape = terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(Array.from(tape.matchAll(/PRE_EDIT_\d+/g), match => match[0])).toEqual(
				Array.from({ length: 40 }, (_, row) => "PRE_EDIT_" + row),
			);
			expect(Array.from(tape.matchAll(/FAILED_EDIT_ROW_\d{2}/g), match => match[0])).toEqual(
				errorLines.map((_, row) => `FAILED_EDIT_ROW_${String(row).padStart(2, "0")}`),
			);
			expect(Array.from(tape.matchAll(/AFTER_FAILED_EDIT_\d{2}/g), match => match[0])).toEqual(
				Array.from({ length: 50 }, (_, row) => "AFTER_FAILED_EDIT_" + String(row).padStart(2, "0")),
			);
		} finally {
			for (const component of ctx.pendingTools.values()) component.seal();
			composer.stop();
		}
	});

	it("commits arbitrary extension results while later calls and assistant text still stream", async () => {
		const terminal = new VirtualTerminal(100, 12);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			preferences: { quiet: true },
			tuiOptions: { renderScheduler: scheduler },
		});
		const customTool: AgentTool = {
			name: "extension_contract_tool",
			label: "Custom",
			description: "History contract test",
			parameters: type({}),
			execute: async () => ({ content: [] }),
			renderResult: result =>
				new Text(result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n"), 0, 0),
		};
		const { controller, ctx, chatContainer } = createFixture(
			false,
			name => (name === customTool.name ? customTool : undefined),
			true,
			composer.ui,
		);
		const calls: ToolCall[] = ["earlier", "later", "active"].map(id => ({
			type: "toolCall",
			id,
			name: customTool.name,
			arguments: {},
		}));
		const markers = (text: string) =>
			Array.from(text.matchAll(/EXTENSION_(earlier|later)_\d{2}/g), match => match[0]);
		const expected = calls
			.slice(0, 2)
			.flatMap(call =>
				Array.from({ length: 40 }, (_, row) => "EXTENSION_" + call.id + "_" + String(row).padStart(2, "0")),
			);
		composer.setRuntimeChildren([chatContainer, new Text("EDITOR", 0, 0)]);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
			const partial = assistantMessage([{ type: "text", text: INTRO_MARKER }, ...calls]);
			await controller.handleEvent({
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 3, toolCall: calls[2]!, partial },
			});
			for (const call of calls)
				await controller.handleEvent({
					type: "tool_execution_start",
					toolCallId: call.id,
					toolName: call.name,
					args: call.arguments,
				});
			await controller.handleEvent({
				type: "tool_execution_update",
				toolCallId: calls[2]!.id,
				toolName: calls[2]!.name,
				args: calls[2]!.arguments,
				partialResult: {
					content: [
						{ type: "text", text: Array.from({ length: 24 }, (_, row) => `EXTENSION_ACTIVE_${row}`).join("\n") },
					],
				},
			});
			for (const index of [1, 0]) {
				const call = calls[index]!;
				await controller.handleEvent({
					type: "tool_execution_end",
					toolCallId: call.id,
					toolName: call.name,
					result: { content: [{ type: "text", text: expected.slice(index * 40, (index + 1) * 40).join("\n") }] },
					isError: false,
				});
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				const history = terminal.getScrollBuffer().slice(0, -terminal.rows).join("\n");
				expect(markers(history)).toEqual(index === 1 ? [] : expected);
			}
			expect(ctx.pendingTools.has("active")).toBeTrue();
			const live = ctx.pendingTools.get("active");
			expect(live).toBeInstanceOf(ToolExecutionComponent);
			if (live instanceof ToolExecutionComponent) expect(live.isTranscriptBlockFinalized()).toBeFalse();
		} finally {
			for (const component of ctx.pendingTools.values()) component.seal();
			composer.stop();
		}
	});

	it("publishes completed tools in call order after a streamed id changes without leaving an active duplicate segment", async () => {
		const terminal = new VirtualTerminal(120, 12);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			preferences: { quiet: true },
			tuiOptions: { renderScheduler: scheduler },
		});
		const { controller, chatContainer, ctx } = createFixture(false, () => undefined, true, composer.ui);
		composer.setRuntimeChildren([chatContainer, new Text("EDITOR", 0, 0)]);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			const first: ToolCall = {
				type: "toolCall",
				id: "temporary-a",
				name: "contract_probe_a",
				arguments: { value: "a" },
			};
			const second: ToolCall = {
				type: "toolCall",
				id: TOOL_CALL_B_ID,
				name: "contract_probe_b",
				arguments: { value: "b" },
			};
			const last: ToolCall = { type: "toolCall", id: "still-streaming-c", name: "contract_probe_c", arguments: {} };
			await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
			const firstPartial = assistantMessage([
				{ type: "text", text: INTRO_MARKER },
				first,
				{ type: "text", text: MIDDLE_MARKER },
			]);
			await controller.handleEvent({
				type: "message_update",
				message: firstPartial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: MIDDLE_MARKER, partial: firstPartial },
			});
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: first.id,
				toolName: first.name,
				args: first.arguments,
			});
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: first.id,
				toolName: first.name,
				result: { content: [{ type: "text", text: TOOL_RESULT_A_MARKER }] },
				isError: false,
			});
			const renamed = { ...first, id: TOOL_CALL_A_ID };
			const secondPartial = assistantMessage([
				{ type: "text", text: INTRO_MARKER },
				renamed,
				{ type: "text", text: MIDDLE_MARKER },
				second,
			]);
			await controller.handleEvent({
				type: "message_update",
				message: secondPartial,
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 3, toolCall: second, partial: secondPartial },
			});
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: second.id,
				toolName: second.name,
				args: second.arguments,
			});
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: second.id,
				toolName: second.name,
				result: { content: [{ type: "text", text: TOOL_RESULT_B_MARKER }] },
				isError: false,
			});
			const lastPartial = assistantMessage([
				...secondPartial.content,
				{ type: "text", text: "CONTINUING BETWEEN SECOND AND THIRD" },
				last,
			]);
			await controller.handleEvent({
				type: "message_update",
				message: lastPartial,
				assistantMessageEvent: {
					type: "toolcall_start",
					contentIndex: 5,
					partial: lastPartial,
				},
			});
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: last.id,
				toolName: last.name,
				args: last.arguments,
			});
			await controller.handleEvent({
				type: "tool_execution_update",
				toolCallId: last.id,
				toolName: last.name,
				args: last.arguments,
				partialResult: {
					content: [
						{ type: "text", text: Array.from({ length: 40 }, (_, index) => `ACTIVE_LAST_${index}`).join("\n") },
					],
				},
			});
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			const history = terminal
				.getScrollBuffer()
				.slice(0, -terminal.rows)
				.map(row => Bun.stripANSI(row));
			expect(history.filter(row => row.includes(TOOL_RESULT_A_MARKER))).toHaveLength(1);
			expect(history.filter(row => row.includes(TOOL_RESULT_B_MARKER))).toHaveLength(1);
			expect(history.filter(row => row.includes(MIDDLE_MARKER))).toHaveLength(1);
			expect(lineContaining(history, TOOL_RESULT_A_MARKER)).toBeLessThan(
				lineContaining(history, TOOL_RESULT_B_MARKER),
			);
			const reconstructed = [...chatContainer.children];
			chatContainer.clear();
			for (const component of reconstructed) chatContainer.addChild(component);
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			const resized = terminal.getScrollBuffer().map(row => Bun.stripANSI(row));
			expect(resized.filter(row => row.includes(TOOL_RESULT_A_MARKER))).toHaveLength(1);
			expect(resized.filter(row => row.includes(TOOL_RESULT_B_MARKER))).toHaveLength(1);
			expect(resized.filter(row => row.includes(MIDDLE_MARKER))).toHaveLength(1);
			const pending = ctx.pendingTools.get(last.id);
			expect(pending).toBeInstanceOf(ToolExecutionComponent);
			if (!(pending instanceof ToolExecutionComponent)) throw new Error("Expected the last tool to remain active");
			expect(pending.isTranscriptBlockFinalized()).toBeFalse();
		} finally {
			for (const component of ctx.pendingTools.values()) component.seal();
			composer.stop();
		}
	});

	it("settles a completion buffered under the old streamed id before later tools can be pinned", async () => {
		const { controller, ctx, chatContainer } = createFixture(false, () => undefined, true);
		ctx.toolOutputExpanded = true;
		const previousPreview = cfgReadToolResultPreview.get(ctx.settings);
		cfgReadToolResultPreview.override(ctx.settings, true);
		try {
			const oldCall: ToolCall = { type: "toolCall", id: "unresolved-read-id", name: "read", arguments: {} };
			const unresolved = assistantMessage([{ type: "text", text: INTRO_MARKER }, oldCall]);
			await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
			await controller.handleEvent({
				type: "message_update",
				message: unresolved,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: unresolved },
			});
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: oldCall.id,
				toolName: "read",
				result: { content: [{ type: "text", text: TOOL_RESULT_A_MARKER }] },
				isError: false,
			});
			const resolvedCall: ToolCall = {
				...oldCall,
				id: "resolved-read-id",
				arguments: { path: "resolved-source.txt" },
			};
			const resolved = assistantMessage([{ type: "text", text: INTRO_MARKER }, resolvedCall]);
			await controller.handleEvent({
				type: "message_update",
				message: resolved,
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: resolvedCall, partial: resolved },
			});
			expect(ctx.pendingTools.has(resolvedCall.id)).toBeFalse();
			const laterCall: ToolCall = {
				type: "toolCall",
				id: "later-still-streaming",
				name: "contract_probe_b",
				arguments: {},
			};
			const laterPartial = assistantMessage([...resolved.content, { type: "text", text: MIDDLE_MARKER }, laterCall]);
			await controller.handleEvent({
				type: "message_update",
				message: laterPartial,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 3, partial: laterPartial },
			});
			const history: string[] = [];
			for (let attempt = 0; attempt <= chatContainer.children.length; attempt++) {
				const batch = chatContainer.peekFinalizedBatch(120, 0);
				if (!batch) break;
				history.push(...batch.rows.map(row => Bun.stripANSI(row)));
				chatContainer.acknowledgeFinalizedBatch(batch.id);
			}
			expect(history.filter(row => row.includes(TOOL_RESULT_A_MARKER))).toHaveLength(1);
		} finally {
			cfgReadToolResultPreview.override(ctx.settings, previousPreview);
			for (const component of ctx.pendingTools.values()) component.seal();
		}
	});

	it("uses the canonical mounted-tool renderer for prefixed calls live and after transcript rebuild", async () => {
		const githubTool: AgentTool = {
			name: "github",
			label: "GitHub",
			description: "GitHub test tool",
			parameters: type({}),
			execute: async () => ({ content: [] }),
		};
		const toolByName = (name: string) => (name === "github" || name === "xd://github" ? githubTool : undefined);
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "toolu_prefixed_github",
			name: "xd://github",
			arguments: { op: "repo_view", repo: "can1357/oh-my-pi" },
		};
		const streaming = assistantMessage([toolCall]);

		const live = createFixture(false, toolByName);
		await live.controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await live.controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 0,
				toolCall,
				partial: streaming,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		expect(Bun.stripANSI(live.chatContainer.render(120).join("\n"))).toContain("GitHub Repo can1357/oh-my-pi");

		const executionOnly = createFixture(false, toolByName);
		await executionOnly.controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		expect(Bun.stripANSI(executionOnly.chatContainer.render(120).join("\n"))).toContain(
			"GitHub Repo can1357/oh-my-pi",
		);

		const rebuilt = createFixture(false, toolByName);
		const rebuiltHelpers = new UiHelpers(rebuilt.ctx);
		rebuilt.ctx.addMessageToChat = (message, options) => rebuiltHelpers.addMessageToChat(message, options);
		rebuiltHelpers.renderSessionContext({
			messages: [streaming],
			models: {},
			injectedTtsrRules: [],
			mode: "none",
		});
		expect(Bun.stripANSI(rebuilt.chatContainer.render(120).join("\n"))).toContain("GitHub Repo can1357/oh-my-pi");

		// Canonicalization is presentation-only; provider replay keeps the wire spelling.
		expect(toolCall.name).toBe("xd://github");
	});

	it("keeps assistant text streaming while hiding bash failures and grouped read activity", async () => {
		const { controller, chatContainer } = createFixture(true);
		const bashCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_A_ID,
			name: "bash",
			arguments: { command: `printf '${HIDDEN_BASH_COMMAND_MARKER}'` },
		};
		const readCall: ToolCall = {
			type: "toolCall",
			id: TOOL_CALL_B_ID,
			name: "read",
			arguments: { path: HIDDEN_READ_PATH_MARKER },
		};
		const started = assistantMessage([]);
		const streaming = assistantMessage([
			{ type: "text", text: INTRO_MARKER },
			bashCall,
			{ type: "text", text: MIDDLE_MARKER },
			readCall,
			{ type: "text", text: FINAL_MARKER },
		]);

		await controller.handleEvent({ type: "message_start", message: started } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 3,
				toolCall: readCall,
				partial: streaming,
			},
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "bash",
			args: bashCall.arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_A_ID,
			toolName: "bash",
			result: { content: [{ type: "text", text: HIDDEN_BASH_FAILURE_MARKER }] },
			isError: true,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "read",
			args: readCall.arguments,
		} as Extract<AgentSessionEvent, { type: "tool_execution_start" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_B_ID,
			toolName: "read",
			result: { content: [{ type: "text", text: "read result must stay hidden" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		await controller.handleEvent({ type: "message_end", message: streaming } as Extract<
			AgentSessionEvent,
			{ type: "message_end" }
		>);

		const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
		expect(rendered).toContain(INTRO_MARKER);
		expect(rendered).toContain(MIDDLE_MARKER);
		expect(rendered).toContain(FINAL_MARKER);
		expect(rendered).not.toContain(HIDDEN_BASH_COMMAND_MARKER);
		expect(rendered).not.toContain(HIDDEN_BASH_FAILURE_MARKER);
		expect(rendered).not.toContain(HIDDEN_READ_PATH_MARKER);
	});

	it("does not recreate a completed grouped read when later thinking arrives", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		const readCall: ToolCall = {
			type: "toolCall",
			id: "read-completed-stable",
			name: "read",
			arguments: { path: "stable-completed-read.ts" },
		};
		const withRead = assistantMessage([{ type: "thinking", thinking: "planning the read" }, readCall]);
		const withLaterThinking = assistantMessage([
			{ type: "thinking", thinking: "planning the read" },
			readCall,
			{ type: "thinking", thinking: "more reasoning after the read finished" },
		]);

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "message_update",
			message: withRead,
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: readCall, partial: withRead },
		} as Extract<AgentSessionEvent, { type: "message_update" }>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: readCall.id,
			toolName: "read",
			result: { content: [{ type: "text", text: "file contents" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		expect(ctx.pendingTools.size).toBe(0);
		expect(chatContainer.children.filter(child => child instanceof ReadToolGroupComponent)).toHaveLength(1);

		await controller.handleEvent({
			type: "message_update",
			message: withLaterThinking,
			assistantMessageEvent: { type: "thinking_delta", delta: "more", contentIndex: 2, partial: withLaterThinking },
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		const groups = chatContainer.children.filter(child => child instanceof ReadToolGroupComponent);
		expect(groups).toHaveLength(1);
		expect(ctx.pendingTools.size).toBe(0);
		expect(Bun.stripANSI(chatContainer.render(120).join("\n"))).toContain("stable-completed-read.ts");
	});

	it("settles a grouped read whose result arrives before the streamed card", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		const readCall: ToolCall = {
			type: "toolCall",
			id: "read-result-before-card",
			name: "read",
			arguments: { path: "result-before-card.ts" },
		};
		const streaming = assistantMessage([readCall]);

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: readCall.id,
			toolName: "read",
			result: { content: [{ type: "text", text: "held read body" }] },
			isError: false,
		} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
		expect(chatContainer.children.filter(child => child instanceof ReadToolGroupComponent)).toHaveLength(0);
		expect(ctx.pendingTools.size).toBe(0);

		await controller.handleEvent({
			type: "message_update",
			message: streaming,
			assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: readCall, partial: streaming },
		} as Extract<AgentSessionEvent, { type: "message_update" }>);

		const groups = chatContainer.children.filter(child => child instanceof ReadToolGroupComponent);
		expect(groups).toHaveLength(1);
		expect(ctx.pendingTools.size).toBe(0);
		expect(Bun.stripANSI(groups[0]!.render(120).join("\n"))).toContain("result-before-card.ts");
	});

	it("finalizes closed inter-tool reasoning so multiple completed greps can retire", async () => {
		const { controller, chatContainer, ctx } = createFixture();
		const greps = [1, 2, 3].map(n => ({
			call: {
				type: "toolCall" as const,
				id: `grep-mixed-${n}`,
				name: "grep",
				arguments: { pattern: `pattern-${n}` },
			},
			result: `GREP_RESULT_${n}_UNIQUE`,
			thinking: `REASONING_AFTER_GREP_${n}`,
		}));

		await controller.handleEvent({ type: "message_start", message: assistantMessage([]) } as Extract<
			AgentSessionEvent,
			{ type: "message_start" }
		>);

		const content: AssistantMessage["content"] = [{ type: "thinking", thinking: "REASONING_BEFORE_TOOLS" }];
		for (const grep of greps) {
			content.push(grep.call);
			const withTool = assistantMessage([...content]);
			await controller.handleEvent({
				type: "message_update",
				message: withTool,
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: content.length - 1,
					toolCall: grep.call,
					partial: withTool,
				},
			} as Extract<AgentSessionEvent, { type: "message_update" }>);
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: grep.call.id,
				toolName: "grep",
				result: { content: [{ type: "text", text: grep.result }] },
				isError: false,
			} as Extract<AgentSessionEvent, { type: "tool_execution_end" }>);
			content.push({ type: "thinking", thinking: grep.thinking });
			const withThinking = assistantMessage([...content]);
			await controller.handleEvent({
				type: "message_update",
				message: withThinking,
				assistantMessageEvent: {
					type: "thinking_delta",
					delta: grep.thinking,
					contentIndex: content.length - 1,
					partial: withThinking,
				},
			} as Extract<AgentSessionEvent, { type: "message_update" }>);
		}

		expect(ctx.pendingTools.size).toBe(0);
		const assistants = chatContainer.children.filter(
			(child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent,
		);
		const tools = chatContainer.children.filter(
			(child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent,
		);
		expect(tools).toHaveLength(3);
		for (const tool of tools) {
			expect(tool.isTranscriptBlockFinalized()).toBe(true);
		}
		expect(assistants.length).toBeGreaterThanOrEqual(3);
		for (const assistant of assistants.slice(0, -1)) {
			expect(assistant.isTranscriptBlockFinalized()).toBe(true);
		}
		expect(assistants.at(-1)!.isTranscriptBlockFinalized()).toBe(false);

		const flushed = Bun.stripANSI(chatContainer.peekFlushBatch(120)?.rows.join("\n") ?? "");
		expect(flushed).toContain("GREP_RESULT_1_UNIQUE");
		expect(flushed).toContain("GREP_RESULT_2_UNIQUE");
	});

	for (const arrival of ["early", "buffered"] as const) {
		it(`renders inline images from ${arrival} held read results`, async () => {
			const protocol = Object.getOwnPropertyDescriptor(TERMINAL, "imageProtocol")!;
			Object.defineProperty(TERMINAL, "imageProtocol", { value: null });
			try {
				const { controller, chatContainer, ctx } = createFixture();
				cfgTerminalShowImages.set(ctx.settings, true);
				const readCall: ToolCall = {
					type: "toolCall",
					id: `read-image-${arrival}`,
					name: "read",
					arguments: { path: "pixel.png" },
				};
				const result: ToolResultMessage = {
					role: "toolResult",
					toolCallId: readCall.id,
					toolName: "read",
					content: [
						{
							type: "image",
							mimeType: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
						},
					],
					isError: false,
					timestamp: 1,
				};
				if (arrival === "buffered") {
					ctx.session.agent.getPendingToolResults = () => [result];
					controller.resetTranscriptAnchors();
				}
				await controller.handleEvent({ type: "message_start", message: assistantMessage([]) });
				if (arrival === "early") {
					await controller.handleEvent({
						type: "tool_execution_end",
						toolCallId: readCall.id,
						toolName: "read",
						result,
						isError: false,
					});
				}
				const message = assistantMessage([{ type: "text", text: "Inspecting the sample image." }, readCall]);
				const update: Extract<AgentSessionEvent, { type: "message_update" }> = {
					type: "message_update",
					message,
					assistantMessageEvent: { type: "toolcall_end", contentIndex: 1, toolCall: readCall, partial: message },
				};
				await controller.handleEvent(update);
				await controller.handleEvent(update);
				const rendered = Bun.stripANSI(chatContainer.render(120).join("\n"));
				expect(rendered.match(/\[Image: image\/png\]/g)).toHaveLength(1);
				expect(ctx.pendingTools.size).toBe(0);
			} finally {
				Object.defineProperty(TERMINAL, "imageProtocol", protocol);
			}
		});
	}
});
