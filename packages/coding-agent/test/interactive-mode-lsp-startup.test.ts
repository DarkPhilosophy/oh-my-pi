import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { DaemonConnectionSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/status";
import { HostedTerminal } from "@oh-my-pi/pi-coding-agent/daemon/terminal-bridge";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "@oh-my-pi/pi-coding-agent/lsp/startup-events";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { LspStartupServerInfo } from "@oh-my-pi/pi-coding-agent/tools";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode LSP startup welcome banner", () => {
	let authStorage: AuthStorage;
	let eventBus: EventBus;
	let lspServers: LspStartupServerInfo[];
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		// Prevent ProcessTerminal.start() from sending escape queries to the real
		// terminal (OSC 11, DA1, kitty protocol, cell-size).  The test only reads
		// rendered output via mode.ui.render(), so real terminal I/O is unnecessary.
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-lsp-startup-");
		const isolatedSettings = await Settings.loadIsolated({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: isolatedSettings,
			modelRegistry,
		});
		eventBus = new EventBus();
		lspServers = [
			{
				name: "rust-analyzer",
				status: "connecting",
				fileTypes: [".rs"],
			},
		];
		mode = new InteractiveMode(session, "test", undefined, () => {}, lspServers, undefined, eventBus);
		// This test exercises the LSP startup banner, not git branch watching.
		// Starting a real fs.watch on the repo HEAD in a parallel Bun worker is
		// enough to trigger a Bun SIGTRAP in unrelated workers during the
		// 4-worker suite reproducer, so keep the watcher out of this contract.
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("renders a hosted session without initializing global settings", async () => {
		await mode.init({ suppressWelcomeIntro: true });

		expect(() =>
			mode.renderInitialMessages({
				preserveExistingChat: true,
				clearTerminalHistory: true,
			}),
		).not.toThrow();
	});

	it("updates the welcome banner when startup warmup completes", async () => {
		await mode.init();

		const findServerLine = () =>
			Bun.stripANSI(mode.ui.render(120).join("\n"))
				.split("\n")
				.find(line => line.includes("rust-analyzer")) ?? "";

		expect(findServerLine()).toContain(theme.status.pending);

		const requestRenderSpy = vi.spyOn(mode.ui, "requestRender");
		const showStatusSpy = vi.spyOn(mode, "showStatus");
		requestRenderSpy.mockClear();
		showStatusSpy.mockClear();

		lspServers[0].status = "ready";
		const event: LspStartupEvent = {
			type: "completed",
			servers: [
				{
					name: "rust-analyzer",
					status: "ready",
					fileTypes: [".rs"],
				},
			],
		};

		eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);

		expect(requestRenderSpy).toHaveBeenCalled();
		expect(showStatusSpy).not.toHaveBeenCalled();
		expect(findServerLine()).toContain(theme.status.enabled);
		expect(findServerLine()).not.toContain(theme.status.pending);
	});

	it("retains daemon status received before the welcome component is initialized", async () => {
		const snapshot: DaemonConnectionSnapshot = {
			state: "connected",
			shard: { profile: "work" },
			daemonId: "2947c11e-ea0e-4b5f-86aa-2d9852e94448",
			sessionId: "019f6362-7273-7ec0-afba-4c729add7c12",
			serverVersion: "1.2.3",
			protocolVersion: 1,
			sessionCount: 2,
		};
		mode.setDaemonSnapshot(snapshot);

		await mode.init({ suppressWelcomeIntro: true });

		const rendered = Bun.stripANSI(mode.ui.render(120).join("\n"));
		expect(rendered).toContain("daemon 2947c11e · v1.2");
		expect(rendered).toContain(" 019f6362 · work");
		expect(rendered).not.toContain("direct mode");
	});

	it("finishes graceful session teardown before closing a hosted terminal", async () => {
		mode.stop();
		const terminal = new HostedTerminal({
			columns: 120,
			rows: 40,
			kittyProtocolActive: false,
			kittyEnableSequence: null,
		});
		const output: string[] = [];
		terminal.setOutput(data => output.push(data));
		const detachReasons: string[] = [];
		mode = new InteractiveMode(session, "test", undefined, () => {}, lspServers, undefined, eventBus, {
			terminal,
			onDetach: reason => detachReasons.push(reason),
		});
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
		const releaseDispose = Promise.withResolvers<void>();
		const disposeStarted = Promise.withResolvers<void>();
		const disposeSpy = vi.spyOn(session, "dispose").mockImplementation(async () => {
			disposeStarted.resolve();
			await releaseDispose.promise;
		});
		const showStatusSpy = vi.spyOn(mode, "showStatus");
		const processQuitSpy = vi.spyOn(postmortem, "quit").mockResolvedValue(undefined as never);

		const shutdown = mode.shutdown();
		await disposeStarted.promise;

		expect(showStatusSpy).toHaveBeenCalledWith("Closing session…");
		expect(Bun.stripANSI(output.join(""))).toContain("Closing session…");
		expect(disposeSpy).toHaveBeenCalledTimes(1);
		expect(detachReasons).toEqual([]);

		releaseDispose.resolve();
		await shutdown;
		expect(detachReasons).toEqual(["exit"]);
		expect(processQuitSpy).not.toHaveBeenCalled();
	});

	it("does not render LSP startup warnings when startup.quiet is enabled", () => {
		session.settings.set("startup.quiet", true);
		const showWarningSpy = vi.spyOn(mode, "showWarning").mockImplementation(() => {});
		eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, {
			type: "failed",
			error: "rust-analyzer timed out",
		} satisfies LspStartupEvent);
		expect(showWarningSpy).not.toHaveBeenCalled();
	});

	it("surfaces a sanitized warning when session persistence fails", async () => {
		await mode.init();
		await session.sessionManager.ensureOnDisk();
		const showWarning = vi.spyOn(mode, "showWarning").mockImplementation(() => {});
		const writeFailure = vi.spyOn(fs, "writeSync").mockImplementation(() => {
			throw Object.assign(new Error("ENOSPC:\tdisk full\n\u001b[31mretry later\u001b[0m"), { code: "ENOSPC" });
		});
		session.sessionManager.appendCustomEntry("persistence-failure-probe", {});

		expect(showWarning).toHaveBeenCalledTimes(1);
		const warning = showWarning.mock.calls[0]?.[0] ?? "";
		expect(warning).toContain("Session persistence failed: ENOSPC:");
		expect(warning).toContain("Unsaved entries remain in memory");
		expect(warning).not.toContain("\t");
		expect(warning).not.toContain("\n");
		expect(warning).not.toContain("\u001b");
		writeFailure.mockRestore();
		session.sessionManager.appendCustomEntry("persistence-recovery-probe", {});
	});
});
