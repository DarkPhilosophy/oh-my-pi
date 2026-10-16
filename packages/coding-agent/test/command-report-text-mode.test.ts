import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { Text } from "@oh-my-pi/pi-tui";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const ROWS = 32;

function screen(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

describe("text-mode command reports on a real terminal core", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let term: VirtualTerminal;

	let writes: string[];
	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-command-report-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		term = new VirtualTerminal(120, ROWS);
		const composer = new Composer({ terminal: term });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	async function mountTranscript(rows: number): Promise<string> {
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await term.waitForRender();
		writes = [];
		const write = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation(data => {
			writes.push(data);
			write(data);
		});
		for (let i = 0; i < rows; i++) mode.chatContainer.addChild(new Text(`TRANSCRIPT ${i}`, 0, 0));
		mode.ui.requestRender();
		const last = `TRANSCRIPT ${rows - 1}`;
		await term.waitForRender(() => screen(term).includes(last));
		return last;
	}

	async function runCommand(command: string, shown: string): Promise<string[]> {
		term.sendInput(command);
		await term.waitForRender(() => screen(term).some(row => row.includes(command)));
		const beforeOpen = screen(term);
		term.sendInput("\r");
		await term.waitForRender(() => screen(term).some(row => row.includes(shown)));
		return beforeOpen;
	}

	function expectTranscript(rows: number): void {
		const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
		expect(buffer.filter(row => /^TRANSCRIPT \d+$/.test(row))).toEqual(
			Array.from({ length: rows }, (_, index) => `TRANSCRIPT ${index}`),
		);
		expect(writes.join("")).not.toContain("\x1b[3J");
	}

	it.each([5, 40])(
		"opens `/changelog full` as a scrollable full-screen page and Esc preserves the conversation (%i transcript rows)",
		async rows => {
			const last = await mountTranscript(rows);
			const beforeOpen = await runCommand("/changelog full", "Full Changelog");
			expect(screen(term).some(row => row.includes("PgUp/PgDn scroll"))).toBe(true);
			expect(screen(term).some(row => row.includes(last))).toBe(false);
			const page = screen(term).join("\n");
			term.sendInput("\x1b[6~");
			await term.waitForRender(() => screen(term).join("\n") !== page);
			expect(screen(term).some(row => row.includes("Full Changelog"))).toBe(true);

			term.sendInput("\x1b");
			await term.waitForRender(() => !screen(term).some(row => row.includes("Full Changelog")));
			expectTranscript(rows);
			// Typing can open an inline completion row; compare against the
			// screen immediately before the fullscreen page, not before typing.
			expect(screen(term).indexOf(last)).toBe(beforeOpen.indexOf(last));
			// Nothing of the page reached the main screen, and no transcript row was duplicated.
			const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			expect(buffer.filter(row => row === last)).toHaveLength(1);
			expect(buffer.some(row => row.includes("Full Changelog"))).toBe(false);
		},
	);

	it("shows a fitting report as an overlay and Esc restores the conversation", async () => {
		const last = await mountTranscript(40);
		await runCommand("/tools", "Available Tools");
		expect(screen(term).some(row => row.includes("to close"))).toBe(true);
		// The overlay does not move stable transcript rows into history.
		expect(screen(term).some(row => row.startsWith("TRANSCRIPT"))).toBe(true);

		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes("Available Tools")));
		expectTranscript(40);
		expect(screen(term).includes(last)).toBe(true);
	});

	it.each([
		["/jobs", "Background jobs"],
		["/tools", "Available Tools"],
		["/mcp help", "MCP Server Management"],
	])("keeps streaming and HUD geometry intact while %s is open", async (command, title) => {
		await mountTranscript(40);
		vi.spyOn(session, "getAsyncJobTree").mockReturnValue({ running: [], recent: [], agents: [] });
		mode.todoContainer.addChild(new Text("TODO_HUD", 0, 0));
		mode.statusContainer.addChild(new Text("JOB_HUD", 0, 0));
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "STREAM_RUNNING" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "fixture",
			stopReason: "stop",
			timestamp: 1,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		await mode.eventController.handleEvent({ type: "message_start", message });
		await mode.eventController.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "STREAM_RUNNING", partial: message },
		});
		mode.ui.requestRender();
		await term.waitForRender(() => screen(term).some(row => row.includes("STREAM_RUNNING")));
		const before = screen(term);
		const mutableTop = mode.ui.getMutableViewport().top;
		await executeBuiltinSlashCommand(command, { ctx: mode });
		await term.waitForRender(() => screen(term).some(row => row.includes(title)));
		expect(mode.ui.hasOverlay()).toBeTrue();
		expect(mode.reportContainer.children).toHaveLength(0);
		expect(mode.ui.getMutableViewport().top).toBe(mutableTop);
		const partial: AssistantMessage = { ...message, content: [{ type: "text", text: "STREAM_RUNNING_UPDATED" }] };
		await mode.eventController.handleEvent({
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "_UPDATED", partial },
		});
		term.sendInput("\x1b");
		await term.waitForRender(
			() => !mode.ui.hasOverlay() && screen(term).some(row => row.includes("STREAM_RUNNING_UPDATED")),
		);
		for (const marker of ["TODO_HUD", "JOB_HUD"]) {
			expect(before.findIndex(row => row.includes(marker))).toBeGreaterThanOrEqual(0);
			expect(screen(term).findIndex(row => row.includes(marker))).toBe(
				before.findIndex(row => row.includes(marker)),
			);
		}
		expectTranscript(40);
		expect(term.getScrollBuffer().join("\n")).not.toContain(title);
		await mode.eventController.handleEvent({ type: "message_end", message: partial });
	});

	it.each([
		["/mcp help", "MCP Server Management"],
		["/mcp list", "MCP Servers"],
		["/ssh help", "SSH Host Management"],
		["/ssh list", "SSH Hosts"],
	])("`%s` reports outside the transcript and Esc takes it away", async (command, title) => {
		await mountTranscript(40);
		const blocks = mode.chatContainer.children.length;
		await runCommand(command, title);
		expect(mode.chatContainer.children).toHaveLength(blocks);

		term.sendInput("\x1b");
		await term.waitForRender(() => !screen(term).some(row => row.includes(title)));
		expectTranscript(40);
		const buffer = term.getScrollBuffer().map(row => Bun.stripANSI(row));
		expect(buffer.some(row => row.includes(title))).toBe(false);
	});
});
