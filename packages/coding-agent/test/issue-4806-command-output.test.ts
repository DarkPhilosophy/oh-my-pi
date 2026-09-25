import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { cfgDisplayCollapseCompacted } from "@oh-my-pi/pi-coding-agent/modes/settings";

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
		HistoryStorage.close();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("mounts slash-command output at the message boundary, after the block it was typed during", async () => {
		const streamedReply = new Text("agent is streaming", 0, 0) as Text & {
			isTranscriptBlockFinalized?: () => boolean;
		};
		streamedReply.isTranscriptBlockFinalized = () => false;
		mode.chatContainer.addChild(streamedReply);

		mode.handleToolsCommand();

		// Queued while the reply streams: mounting above the block that started
		// before the command would read as if it had been typed earlier.
		expect(mode.chatContainer.children).toHaveLength(1);
		expect(mode.chatContainer.render(80).join("\n")).not.toContain("Available Tools");

		mode.mountQueuedCommandOutput();

		expect(mode.chatContainer.children).toHaveLength(2);
		expect(mode.chatContainer.children[0]).toBe(streamedReply);
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
		mode.mountQueuedCommandOutput();

		// Compaction/auto-compaction rebuilds replay only state.messages, which
		// never contains command panels; the mid-turn panel must survive anyway.
		mode.rebuildChatFromMessages();

		const transcript = mode.chatContainer.render(80).join("\n");
		expect(transcript.match(/Available Tools/g)).toHaveLength(1);
	});

	// A settled todo snapshot no longer counts as live: fork commit 1faadd6757
	// ("preserve logical live frames and exact-once history") finalizes
	// displaceable blocks, so the live region here is a tool call whose result
	// has not landed yet.
	it("keeps restored slash-command output after a replayed live tool call", () => {
		const command = "printf still-running";
		const pendingTool = new ToolExecutionComponent(
			"bash",
			{ command },
			{},
			undefined,
			mode.ui,
			tempDir.path(),
			"live-anchor",
		);
		try {
			mode.chatContainer.addChild(pendingTool);
			mode.pendingTools.set("live-anchor", pendingTool);
			mode.handleToolsCommand();
			mode.mountQueuedCommandOutput();
			const commandPanel = mode.chatContainer.children[mode.chatContainer.children.length - 1]!;

			const assistant = {
				role: "assistant",
				content: [{ type: "toolCall", id: "live-anchor", name: "bash", arguments: { command } }],
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
			session.sessionManager.appendMessage(assistant);
			session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);

			mode.rebuildChatFromMessages();

			const commandPanelIndex = mode.chatContainer.children.indexOf(commandPanel);
			const liveBlockIndex = mode.chatContainer.children.findIndex(child => {
				const block = child as Text & { isTranscriptBlockFinalized?: () => boolean };
				return block.isTranscriptBlockFinalized?.() === false;
			});
			expect(commandPanelIndex).toBeGreaterThanOrEqual(0);
			expect(liveBlockIndex).toBeGreaterThanOrEqual(0);
			expect(commandPanelIndex).toBeGreaterThan(liveBlockIndex);
		} finally {
			pendingTool.stopAnimation();
		}
	});

	it("keeps command output after a tool block that settles before the rebuild", () => {
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
			mode.mountQueuedCommandOutput();
			const commandPanel = mode.chatContainer.children[mode.chatContainer.children.length - 1]!;
			expect(mode.chatContainer.children.indexOf(commandPanel)).toBeGreaterThan(
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
			expect(mode.chatContainer.children.indexOf(commandPanel)).toBeGreaterThan(settledToolIndex);
		} finally {
			pendingTool.stopAnimation();
		}
	});

	it("keeps command output anchored when collapsed compaction removes its transcript prefix", () => {
		cfgDisplayCollapseCompacted.set(session.settings, true);
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "prefix removed by compaction" }],
			timestamp: Date.now(),
		} as Message);
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "prefix reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as Message);
		mode.rebuildChatFromMessages();

		const command = "printf compacted-command-anchor";
		const pendingTool = new ToolExecutionComponent(
			"bash",
			{ command },
			{},
			undefined,
			mode.ui,
			tempDir.path(),
			"compacted-command-anchor",
		);
		try {
			mode.chatContainer.addChild(pendingTool);
			mode.pendingTools.set("compacted-command-anchor", pendingTool);
			mode.handleToolsCommand();
			mode.mountQueuedCommandOutput();
			const commandPanel = mode.chatContainer.children.find(child =>
				Bun.stripANSI(child.render(120).join("\n")).includes("Available Tools"),
			);
			expect(commandPanel).toBeDefined();

			const firstKeptEntryId = session.sessionManager.appendMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "compacted-command-anchor",
						name: "bash",
						arguments: { command },
					},
				],
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
			} as Message);
			session.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "compacted-command-anchor",
				toolName: "bash",
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: Date.now(),
			} as Message);
			session.sessionManager.appendCompaction("compacted prefix", undefined, firstKeptEntryId, 100);
			session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);

			mode.rebuildChatFromMessages();

			const transcript = Bun.stripANSI(mode.chatContainer.render(120).join("\n"));
			expect(transcript).not.toContain("prefix removed by compaction");
			const settledToolIndex = mode.chatContainer.children.findIndex(child =>
				Bun.stripANSI(child.render(120).join("\n")).includes(command),
			);
			expect(settledToolIndex).toBeGreaterThanOrEqual(0);
			expect(mode.chatContainer.children.indexOf(commandPanel!)).toBeGreaterThan(settledToolIndex);
		} finally {
			pendingTool.stopAnimation();
		}
	});

	it("keeps command output after a replayed sibling when its first anchor remains pending", () => {
		cfgDisplayCollapseCompacted.set(session.settings, true);
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "long prefix removed before pending anchor" }],
			timestamp: Date.now(),
		} as Message);
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "prefix reply before pending anchor" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		} as Message);
		mode.rebuildChatFromMessages();

		const pendingCommand = "printf preserved-pending-anchor";
		const settledCommand = "printf replayed-later-sibling";
		const pendingTool = new ToolExecutionComponent(
			"bash",
			{ command: pendingCommand },
			{},
			undefined,
			mode.ui,
			tempDir.path(),
			"preserved-pending-anchor",
		);
		const settledTool = new ToolExecutionComponent(
			"bash",
			{ command: settledCommand },
			{},
			undefined,
			mode.ui,
			tempDir.path(),
			"replayed-later-sibling",
		);
		try {
			settledTool.updateResult(
				{ content: [{ type: "text", text: "" }], isError: false },
				false,
				"replayed-later-sibling",
			);
			mode.chatContainer.addChild(pendingTool);
			mode.chatContainer.addChild(settledTool);
			mode.pendingTools.set("preserved-pending-anchor", pendingTool);
			mode.pendingTools.set("replayed-later-sibling", settledTool);
			mode.handleToolsCommand();
			mode.mountQueuedCommandOutput();
			const commandPanel = mode.chatContainer.children.find(child =>
				Bun.stripANSI(child.render(120).join("\n")).includes("Available Tools"),
			);
			expect(commandPanel).toBeDefined();
			expect(mode.chatContainer.children.indexOf(commandPanel!)).toBeGreaterThan(
				mode.chatContainer.children.indexOf(pendingTool),
			);
			expect(mode.chatContainer.children.indexOf(commandPanel!)).toBeGreaterThan(
				mode.chatContainer.children.indexOf(settledTool),
			);
			mode.pendingTools.delete("replayed-later-sibling");

			const firstKeptEntryId = session.sessionManager.appendMessage({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "preserved-pending-anchor",
						name: "bash",
						arguments: { command: pendingCommand },
					},
					{
						type: "toolCall",
						id: "replayed-later-sibling",
						name: "bash",
						arguments: { command: settledCommand },
					},
				],
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
			} as Message);
			session.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "replayed-later-sibling",
				toolName: "bash",
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: Date.now(),
			} as Message);
			session.sessionManager.appendCompaction("compacted pending prefix", undefined, firstKeptEntryId, 100);
			session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);

			mode.rebuildChatFromMessages();

			const replayedSettledIndex = mode.chatContainer.children.findIndex(child =>
				Bun.stripANSI(child.render(120).join("\n")).includes(settledCommand),
			);
			const commandPanelIndex = mode.chatContainer.children.indexOf(commandPanel!);
			expect(replayedSettledIndex).toBeGreaterThanOrEqual(0);
			expect(mode.chatContainer.children.indexOf(pendingTool)).toBeGreaterThanOrEqual(0);
			expect(commandPanelIndex).toBeGreaterThan(replayedSettledIndex);
			expect(commandPanelIndex).toBeGreaterThan(mode.chatContainer.children.indexOf(pendingTool));
			expect(mode.chatContainer.children.indexOf(pendingTool)).toBeLessThan(replayedSettledIndex);
		} finally {
			pendingTool.stopAnimation();
			settledTool.stopAnimation();
		}
	});

	it("restores command output after the last tool of a multi-tool assistant turn", () => {
		const earlierCommand = "printf earlier-tool";
		const anchoredCommand = "printf exact-tool-anchor";
		const earlierTool = new ToolExecutionComponent(
			"bash",
			{ command: earlierCommand },
			{},
			undefined,
			mode.ui,
			tempDir.path(),
			"earlier-tool",
		);
		const pendingTool = new ToolExecutionComponent(
			"bash",
			{ command: anchoredCommand },
			{},
			undefined,
			mode.ui,
			tempDir.path(),
			"exact-tool-anchor",
		);
		try {
			earlierTool.updateResult({ content: [{ type: "text", text: "" }], isError: false }, false, "earlier-tool");
			mode.chatContainer.addChild(earlierTool);
			mode.chatContainer.addChild(pendingTool);
			mode.pendingTools.set("exact-tool-anchor", pendingTool);
			mode.handleToolsCommand();
			mode.mountQueuedCommandOutput();
			const commandPanel = mode.chatContainer.children.find(child =>
				Bun.stripANSI(child.render(120).join("\n")).includes("Available Tools"),
			);
			expect(commandPanel).toBeDefined();
			expect(mode.chatContainer.children.indexOf(earlierTool)).toBeLessThan(
				mode.chatContainer.children.indexOf(commandPanel!),
			);
			expect(mode.chatContainer.children.indexOf(pendingTool)).toBeLessThan(
				mode.chatContainer.children.indexOf(commandPanel!),
			);

			session.sessionManager.appendMessage({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "earlier-tool", name: "bash", arguments: { command: earlierCommand } },
					{
						type: "toolCall",
						id: "exact-tool-anchor",
						name: "bash",
						arguments: { command: anchoredCommand },
					},
				],
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
			} as Message);
			session.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "earlier-tool",
				toolName: "bash",
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: Date.now(),
			} as Message);
			session.sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "exact-tool-anchor",
				toolName: "bash",
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: Date.now(),
			} as Message);
			session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);

			mode.rebuildChatFromMessages();

			const replayedEarlierToolIndex = mode.chatContainer.children.findIndex(child =>
				Bun.stripANSI(child.render(120).join("\n")).includes(earlierCommand),
			);
			const replayedAnchoredToolIndex = mode.chatContainer.children.findIndex(child =>
				Bun.stripANSI(child.render(120).join("\n")).includes(anchoredCommand),
			);
			const commandPanelIndex = mode.chatContainer.children.indexOf(commandPanel!);
			expect(replayedEarlierToolIndex).toBeGreaterThanOrEqual(0);
			expect(replayedAnchoredToolIndex).toBeGreaterThan(replayedEarlierToolIndex);
			expect(commandPanelIndex).toBeGreaterThan(replayedEarlierToolIndex);
			expect(commandPanelIndex).toBeGreaterThan(replayedAnchoredToolIndex);
		} finally {
			earlierTool.stopAnimation();
			pendingTool.stopAnimation();
		}
	});

	it("drops slash-command output mounted for a previous session", async () => {
		mode.handleToolsCommand();
		mode.mountQueuedCommandOutput();
		const previousSessionId = session.sessionManager.getSessionId();

		await session.newSession();
		expect(session.sessionManager.getSessionId()).not.toBe(previousSessionId);
		mode.rebuildChatFromMessages();

		expect(mode.chatContainer.children).toHaveLength(0);
	});
});
