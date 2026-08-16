import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-coding-agent/modes/components/tool-execution";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("issue #4806 command output during streaming", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let streaming = true;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-4806-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		mode = new InteractiveMode(session, "test");
		mode.isInitialized = true;
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		HistoryStorage.resetInstance();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("mounts slash-command output immediately, above the live streaming region", async () => {
		const streamedReply = new Text("agent is streaming", 0, 0) as Text & {
			isTranscriptBlockFinalized?: () => boolean;
		};
		streamedReply.isTranscriptBlockFinalized = () => false;
		mode.chatContainer.addChild(streamedReply);

		mode.handleToolsCommand();

		// The panel mounts right away — read-only commands never wait for the
		// turn to end — and lands above the still-live streaming block so the
		// transcript stays in event order.
		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.chatContainer.children[1]).toBe(streamedReply);
		let transcript = mode.chatContainer.render(80).join("\n");
		expect(transcript.match(/Available Tools/g)).toHaveLength(1);

		// Turn end neither remounts nor duplicates the already-settled panel.
		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		expect(mode.chatContainer.children).toHaveLength(2);
		transcript = mode.chatContainer.render(80).join("\n");
		expect(transcript.match(/Available Tools/g)).toHaveLength(1);
	});

	it("keeps mid-turn slash-command output through a transcript rebuild", () => {
		mode.handleToolsCommand();

		// Compaction/auto-compaction rebuilds replay only state.messages, which
		// never contains command panels; the mid-turn panel must survive anyway.
		mode.rebuildChatFromMessages();

		const transcript = mode.chatContainer.render(80).join("\n");
		expect(transcript.match(/Available Tools/g)).toHaveLength(1);
	});

	it("keeps restored slash-command output above a replayed live todo", () => {
		const commandPanel = (() => {
			mode.handleToolsCommand();
			return mode.chatContainer.children[0];
		})();
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant = {
			role: "assistant",
			content: [{ type: "toolCall", id: "todo-live", name: "todo", arguments: { op: "view" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage,
			timestamp: Date.now(),
		} as unknown as Message;
		const todoResult = {
			role: "toolResult",
			toolCallId: "todo-live",
			toolName: "todo",
			content: [{ type: "text", text: "" }],
			details: {
				phases: [{ name: "Work", tasks: [{ content: "Keep panel stable", status: "in_progress" }] }],
			},
			isError: false,
			timestamp: Date.now(),
		} as unknown as Message;
		session.sessionManager.appendMessage(assistant);
		session.sessionManager.appendMessage(todoResult);
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);

		mode.rebuildChatFromMessages();

		const commandPanelIndex = mode.chatContainer.children.indexOf(commandPanel);
		const liveBlockIndex = mode.chatContainer.children.findIndex(child => {
			const block = child as Text & { isTranscriptBlockFinalized?: () => boolean };
			return block.isTranscriptBlockFinalized?.() === false;
		});
		expect(commandPanelIndex).toBeGreaterThanOrEqual(0);
		expect(liveBlockIndex).toBeGreaterThanOrEqual(0);
		expect(commandPanelIndex).toBeLessThan(liveBlockIndex);
	});

	it("keeps command output before a tool block that settles before the rebuild", () => {
		const command = "printf command-anchor";
		const pendingTool = new ToolExecutionComponent(
			"bash",
			{ command },
			{},
			undefined,
			mode.ui,
			tempDir.path(),
			"command-anchor",
		);
		try {
			mode.chatContainer.addChild(pendingTool);
			mode.pendingTools.set("command-anchor", pendingTool);
			mode.handleToolsCommand();
			const commandPanel = mode.chatContainer.children[0];
			expect(mode.chatContainer.children.indexOf(commandPanel)).toBeLessThan(
				mode.chatContainer.children.indexOf(pendingTool),
			);

			const assistant = {
				role: "assistant",
				content: [{ type: "toolCall", id: "command-anchor", name: "bash", arguments: { command } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "toolUse",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			} as unknown as Message;
			const result = {
				role: "toolResult",
				toolCallId: "command-anchor",
				toolName: "bash",
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: Date.now(),
			} as unknown as Message;
			session.sessionManager.appendMessage(assistant);
			session.sessionManager.appendMessage(result);
			session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);

			mode.rebuildChatFromMessages();

			const settledToolIndex = mode.chatContainer.children.findIndex(child =>
				Bun.stripANSI(child.render(120).join("\n")).includes(command),
			);
			expect(settledToolIndex).toBeGreaterThanOrEqual(0);
			expect(mode.chatContainer.children.indexOf(commandPanel)).toBeLessThan(settledToolIndex);
		} finally {
			pendingTool.stopAnimation();
		}
	});

	it("drops slash-command output mounted for a previous session", async () => {
		mode.handleToolsCommand();
		const previousSessionId = session.sessionManager.getSessionId();

		await session.newSession();
		expect(session.sessionManager.getSessionId()).not.toBe(previousSessionId);
		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.children).toHaveLength(0);
	});
});
