import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pluginHelpers from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer, type ComposerPreferences } from "@oh-my-pi/pi-tui/prompt/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	applyStartupComposerPreferences,
	beginStartupComposer,
	ComposerLease,
	setStartupComposerLspServers,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { CombinedAutocompleteProvider, type Component } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./collab/helpers/in-memory-relay";
import { assistantMsg, createTestSession } from "./utilities";

import {
	cfgAutocompleteMaxVisible,
	cfgComposerShape,
	cfgMarketplaceAutoUpdate,
	cfgShowHardwareCursor,
	cfgSpellingAutocomplete,
	cfgSpellingAutocorrect,
	cfgSpellingTypoDetection,
	cfgStartupChangelogMode,
	cfgStartupCheckUpdate,
	cfgStartupQuiet,
	cfgStartupSetupWizard,
	cfgStartupShowSplash,
	cfgTuiImeSafeCursor,
	cfgTuiMaxInlineImages,
	cfgTuiResizeScrollback,
} from "@oh-my-pi/pi-coding-agent/modes/settings";

class CountingTerminal extends VirtualTerminal {
	starts = 0;
	stops = 0;
	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.starts += 1;
		super.start(onInput, onResize);
	}

	override stop(): void {
		this.stops += 1;
		super.stop();
	}
}

class ThrowingStartTerminal extends CountingTerminal {
	override start(): void {
		this.starts += 1;
		throw new Error("terminal start failed");
	}
}
class InputTrackingTerminal extends CountingTerminal {
	startOptions: { deferInput?: boolean } | undefined;
	inputEnables = 0;
	override start(
		onInput: (data: string) => void,
		onResize: () => void,
		_onDisconnect?: () => void,
		options?: { deferInput?: boolean },
	): void {
		this.startOptions = options;
		super.start(onInput, onResize);
	}

	enableInput(): void {
		this.inputEnables += 1;
	}
}
class GrowingBlock implements Component {
	#lines: string[] = [];
	#finalized = false;

	append(line: string): void {
		this.#lines.push(line);
	}

	finalize(): void {
		this.#finalized = true;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	render(): readonly string[] {
		return this.#lines;
	}
}

describe("outer startup collaboration gate", () => {
	it.each(["completes", "fails"] as const)("keeps guest mutations gated until outer startup %s", async result => {
		const originalProject = getProjectDir();
		const originalIsTTY = process.stdin.isTTY;
		resetSettingsForTest();
		await initTheme();
		const testSession = await createTestSession({
			inMemory: true,
			settingsOverrides: {
				"collab.autoStart": "control",
				"collab.relayUrl": "ws://localhost:8788",
				"collab.webUrl": "https://collab.example",
			},
		});
		setProjectDir(testSession.tempDir);
		const activeSettings = await Settings.init({ inMemory: true, cwd: testSession.tempDir });
		cfgStartupCheckUpdate.override(activeSettings, false);
		cfgStartupChangelogMode.override(activeSettings, "hidden");
		cfgStartupSetupWizard.override(activeSettings, false);
		cfgStartupShowSplash.override(activeSettings, false);
		cfgMarketplaceAutoUpdate.override(activeSettings, "off");
		installInMemoryRelay();
		const publish = registry.publishCollabHost;
		vi.spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
			publish(source, { ...options, dir: testSession.tempDir }),
		);
		vi.spyOn(ModelRegistry.prototype, "refreshInBackground").mockImplementation(() => {});
		vi.spyOn(pluginHelpers, "preloadPluginRoots").mockResolvedValue(undefined);
		const init = InteractiveMode.prototype.init;
		vi.spyOn(InteractiveMode.prototype, "init").mockImplementation(function (this: InteractiveMode, options) {
			vi.spyOn(this.statusLine, "watchBranch").mockImplementation(() => {});
			return init.call(this, options);
		});
		const enteredReplay = Promise.withResolvers<InteractiveMode>();
		const releaseReplay = Promise.withResolvers<void>();
		const enteredCleanup = Promise.withResolvers<void>();
		const releaseCleanup = Promise.withResolvers<void>();
		const startupFailure = new Error("initial replay failed");
		const finished = new Error("finished observing startup");
		const renderInitialMessages = InteractiveMode.prototype.renderInitialMessages;
		vi.spyOn(InteractiveMode.prototype, "renderInitialMessages").mockImplementation(
			async function (this: InteractiveMode, options) {
				await renderInitialMessages.call(this, options);
				enteredReplay.resolve(this);
				await releaseReplay.promise;
				if (result === "fails") throw startupFailure;
			},
		);
		vi.spyOn(InteractiveMode.prototype, "getUserInput").mockRejectedValue(finished);
		type GuestOutcome = "refused" | "prompt" | "abort" | "agent";
		let outcome = Promise.withResolvers<GuestOutcome>();
		vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);
		const prompt = vi.spyOn(testSession.session, "promptCustomMessage").mockImplementation(async () => {
			outcome.resolve("prompt");
			return true;
		});
		const abort = vi.spyOn(testSession.session, "abort").mockImplementation(async () => {
			outcome.resolve("abort");
		});
		const ensureLive = vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockImplementation(async () => {
			outcome.resolve("agent");
			return testSession.session;
		});
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		const authStorage = await AuthStorage.create(path.join(testSession.tempDir, "startup-auth.db"));
		beginStartupComposer({ terminal: new VirtualTerminal(), version: "test", cache: false });
		const rawArgs = ["--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp"];
		const running = runRootCommand(parseArgs(rawArgs), rawArgs, {
			settings: activeSettings,
			discoverAuthStorage: async () => authStorage,
			createAgentSession: async options => {
				if (!options?.preloadedExtensions || !options.eventBus) throw new Error("Missing startup context");
				await options.sessionManager?.close();
				return {
					session: testSession.session,
					setToolUIContext: () => {},
					extensionsResult: options.preloadedExtensions,
					eventBus: options.eventBus,
				};
			},
		}).then(
			() => undefined,
			error => error,
		);
		let mode: InteractiveMode | undefined;
		let writer: CollabSocket | undefined;
		try {
			mode = await Promise.race([
				enteredReplay.promise,
				running.then(error => {
					throw error ?? new Error("startup exited before replay");
				}),
			]);
			await mode.collabController.idle();
			const host = mode.collabHost;
			if (!host) throw new Error("early startup room missing");
			expect(await registry.listCollabHosts({ dir: testSession.tempDir })).toMatchObject([{ access: "control" }]);
			const link = parseCollabLink(host.link);
			if ("error" in link) throw new Error(link.error);
			const welcomed = Promise.withResolvers<boolean>();
			const asked = Promise.withResolvers<number>();
			writer = new CollabSocket({ wsUrl: link.wsUrl, role: "guest", key: await importRoomKey(link.key) });
			writer.onFrame = frame => {
				if (frame.t === "welcome") welcomed.resolve(frame.readOnly === true);
				if (frame.t === "error") outcome.resolve("refused");
				if (frame.t === "ui-request") asked.resolve(frame.request.reqId);
			};
			const guest = writer;
			guest.onOpen = () =>
				guest.send({
					t: "hello",
					proto: COLLAB_PROTO,
					name: "writer",
					writeToken: link.writeToken ? Buffer.from(link.writeToken).toString("base64url") : undefined,
				});
			guest.connect();
			expect(await welcomed.promise).toBe(false);
			const mutations: CollabFrame[] = [
				{ t: "prompt", text: "during replay" },
				{ t: "abort" },
				{ t: "agent-cmd", cmd: "chat", agentId: "startup-agent", text: "during replay" },
			];
			for (const frame of mutations) {
				outcome = Promise.withResolvers<GuestOutcome>();
				guest.send(frame);
				expect(await outcome.promise).toBe("refused");
			}
			expect(prompt).not.toHaveBeenCalled();
			expect(abort).not.toHaveBeenCalled();
			expect(ensureLive).not.toHaveBeenCalled();
			const answer = host.requestGuestUi({ kind: "select", title: "Startup question", options: ["Yes", "No"] });
			if (!answer) throw new Error("startup dialog unavailable");
			guest.send({ t: "ui-response", reqId: await asked.promise, value: "Yes" });
			expect(await answer).toEqual({ kind: "answered", value: "Yes" });

			if (result === "fails") {
				const shutdown = mode.collabController.shutdown.bind(mode.collabController);
				vi.spyOn(mode.collabController, "shutdown").mockImplementation(async reason => {
					enteredCleanup.resolve();
					await releaseCleanup.promise;
					await shutdown(reason);
				});
			}
			releaseReplay.resolve();
			if (result === "fails") {
				await enteredCleanup.promise;
				outcome = Promise.withResolvers<GuestOutcome>();
				guest.send({ t: "prompt", text: "during failure cleanup" });
				expect(await outcome.promise).toBe("refused");
				expect(prompt).not.toHaveBeenCalled();
				releaseCleanup.resolve();
				expect(await running).toBe(startupFailure);
				expect(await registry.listCollabHosts({ dir: testSession.tempDir })).toEqual([]);
			} else {
				expect(await running).toBe(finished);
				outcome = Promise.withResolvers<GuestOutcome>();
				guest.send({ t: "prompt", text: "after startup" });
				expect(await outcome.promise).toBe("prompt");
				expect(prompt).toHaveBeenCalledWith(
					expect.objectContaining({ content: "after startup", attribution: "user" }),
					expect.objectContaining({ streamingBehavior: "steer" }),
				);
			}
		} finally {
			releaseReplay.resolve();
			releaseCleanup.resolve();
			await running;
			writer?.close();
			await mode?.collabController.shutdown("test cleanup");
			mode?.stop();
			stopPendingStartupComposer();
			vi.restoreAllMocks();
			uninstallInMemoryRelay();
			authStorage.close();
			await testSession.cleanup();
			resetSettingsForTest();
			setProjectDir(originalProject);
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		}
	});
});

describe("Composer prepaint", () => {
	let settings: Settings;

	let config: ComposerPreferences;
	beforeEach(async () => {
		resetSettingsForTest();
		await initTheme();
		settings = await Settings.init({ inMemory: true });
		config = {
			quiet: cfgStartupQuiet.get(settings),
			composerShape: cfgComposerShape.get(settings) ?? "box",
			showHardwareCursor: cfgShowHardwareCursor.get(settings),
			maxInlineImages: cfgTuiMaxInlineImages.get(settings),
			resizeScrollback: cfgTuiResizeScrollback.get(settings),
			imeSafeCursor: cfgTuiImeSafeCursor.get(settings),
			autocompleteMaxVisible: cfgAutocompleteMaxVisible.get(settings),
			spellingTypoDetection: cfgSpellingTypoDetection.get(settings),
			spellingAutocomplete: cfgSpellingAutocomplete.get(settings),
			spellingAutocorrect: cfgSpellingAutocorrect.get(settings),
		};
	});

	afterEach(() => {
		stopPendingStartupComposer();
		resetSettingsForTest();
	});

	it.each(["normal", "expanded", "varied", "flush"])(
		"preserves streamed fenced-code history through %s finalization",
		async mode => {
			const terminal = new CountingTerminal(60, 12);
			const composer = new Composer({ preferences: { ...config, quiet: true }, terminal });
			const transcript = new TranscriptContainer();
			const message = new AssistantMessageComponent(undefined, false);
			let expanded = false;
			composer.editor.setAutocompleteProvider(
				new CombinedAutocompleteProvider(Array.from({ length: 12 }, (_, index) => ({ name: `command${index}` }))),
			);
			transcript.addChild(message);
			composer.setRuntimeChildren([transcript, composer.editor]);
			composer.start();
			const markers = Array.from({ length: 30 }, (_, index) => `MARKER_${String(index + 1).padStart(2, "0")}`);
			let text = "```text\n";
			const streamed: string[] = [];
			try {
				for (const marker of markers) {
					const suffix =
						mode === "varied" ? "Șir cu diacritice ".repeat((streamed.length % 3) + 1) : "x".repeat(42);
					text += `${marker} ${suffix}\n`;
					streamed.push(marker);
					if ((mode === "expanded" || mode === "varied") && marker === "MARKER_10") {
						expanded = true;
						composer.editor.handleInput("/");
						await terminal.waitForRender();
					}
					message.updateContent(assistantMsg(text), { transient: true });
					composer.ui.renderNow();
					const liveTape = terminal
						.getScrollBuffer()
						.map(row => Bun.stripANSI(row))
						.join("\n");
					const liveMarkers = Array.from(liveTape.match(/MARKER_\d{2}/g) ?? []);
					// A streamed marker may never appear twice, and the visible order
					// must follow the stream — never "1,2,6,7" or a duplicated row.
					expect(liveMarkers).toEqual([...new Set(liveMarkers)]);
					expect(liveMarkers).toEqual(streamed.filter(marker => liveMarkers.includes(marker)));
					// With no transient expansion open, every streamed row is on the
					// scrollback-backed buffer. While expanded, clipped rows must still
					// be recoverable — asserted immediately after contraction below.
					if (!expanded) expect(liveMarkers).toEqual(streamed);
				}
				text += "```";
				message.updateContent(assistantMsg(text), { transient: true });
				composer.ui.renderNow();
				text += "\n\nFinished.";
				message.updateContent(assistantMsg(text), { transient: true });
				composer.ui.renderNow();
				message.updateContent(assistantMsg(text), { transient: false });
				message.markTranscriptBlockFinalized();
				if (mode === "flush") {
					composer.stop();
				} else {
					composer.ui.renderNow();
					await terminal.waitForRender();
					composer.ui.renderNow();
					if (expanded) composer.editor.handleInput("\x7f");
					expanded = false;
					composer.ui.renderNow();
					await terminal.waitForRender();
					const finalViewport = terminal.getViewport().map(row => row.trimEnd());
					expect(terminal.getCursor().row, JSON.stringify(finalViewport)).toBe(11);
					if (mode === "expanded" || mode === "varied") {
						const settledViewport = terminal.getViewport().map(row => row.trimEnd());
						const states = transcript.blockStates();
						for (let cycle = 0; cycle < 3; cycle++) {
							composer.editor.handleInput("/");
							await terminal.waitForRender();
							composer.ui.renderNow();
							await terminal.waitForRender();
							const expandedTape = terminal
								.getScrollBuffer()
								.map(row => Bun.stripANSI(row))
								.join("\n");
							const visibleMarkers = Array.from(expandedTape.match(/MARKER_\d{2}/g) ?? []);
							// Suggestions may cover rows; closing must recover every marker exactly once.
							expect(visibleMarkers).toEqual(markers.filter(marker => visibleMarkers.includes(marker)));
							composer.editor.handleInput("\x7f");
							composer.ui.renderNow();
							await terminal.waitForRender();
							expect(terminal.getViewport().map(row => row.trimEnd())).toEqual(settledViewport);
							expect(
								Array.from(
									terminal
										.getScrollBuffer()
										.join("\n")
										.match(/MARKER_\d{2}/g) ?? [],
								),
							).toEqual(markers);
							expect(transcript.blockStates()).toEqual(states);
						}
					}
				}
				const tape = terminal
					.getScrollBuffer()
					.map(line => Bun.stripANSI(line))
					.join("\n");
				expect(Array.from(tape.match(/MARKER_\d{2}/g) ?? [])).toEqual(markers);
				expect(tape).not.toContain("```text");
			} finally {
				composer.stop();
				message.dispose();
			}
		},
	);

	it("keeps one live editor and terminal across handoff", () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		const submit = vi.fn();
		composer.editor.onSubmit = submit;

		composer.start();
		terminal.sendInput("alpha");
		terminal.sendInput("\r");

		expect(composer.editor.getExpandedText()).toBe("alpha");
		expect(submit).not.toHaveBeenCalled();
		expect(terminal.starts).toBe(1);

		composer.transfer();
		composer.stop();
		terminal.sendInput(" beta");

		expect(composer.editor.getExpandedText()).toBe("alpha beta");
		expect(terminal.starts).toBe(1);
		expect(terminal.stops).toBe(0);

		composer.ui.stop();
		expect(terminal.stops).toBe(1);
	});
	it("reports physically borrowed transcript ownership without retiring live blocks", async () => {
		const terminal = new CountingTerminal(80, 12);
		const composer = new Composer({ preferences: { ...config, quiet: true }, terminal });
		const transcript = new TranscriptContainer();
		const tall = new GrowingBlock();
		for (let index = 0; index < 30; index++) tall.append(`row ${index}`);
		const later = new GrowingBlock();
		later.append("still live");
		transcript.addChild(tall);
		transcript.addChild(later);
		composer.setRuntimeChildren([transcript, composer.editor]);
		composer.start();
		try {
			composer.ui.requestRender(true);
			await terminal.waitForRender();
			expect(transcript.isBlockUncommitted(tall)).toBe(false);
			expect(transcript.canRemoveBlock(tall)).toBe(false);
			expect(transcript.isBlockUncommitted(later)).toBe(true);
			expect(transcript.canRemoveBlock(later)).toBe(true);
			expect(transcript.blockStates()).toEqual(["active", "active"]);
			const plan = composer.renderFrame({ columns: 80, rows: 12 });
			expect(plan.borrowedViewportRows).toBe(Math.max(0, plan.viewport.length - 12));
		} finally {
			composer.stop();
		}
	});

	it("preserves every numbered row when the logical viewport grows beyond terminal height", async () => {
		const terminal = new CountingTerminal(80, 32);
		const composer = new Composer({ preferences: config, terminal });
		const transcript = new TranscriptContainer();
		const block = new GrowingBlock();
		transcript.addChild(block);
		composer.setRuntimeChildren([transcript, composer.editor]);
		composer.start();

		const lines = Array.from({ length: 60 }, (_value, index) => `${index + 1}. numbered row`);
		for (const line of lines) {
			block.append(line);
			composer.ui.requestRender(true);
			await terminal.waitForRender();
		}

		const tape = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimStart());
		expect(lines.map(line => tape.filter(row => row === line).length)).toEqual(lines.map(() => 1));

		const next = new GrowingBlock();
		next.append("next live row");
		transcript.addChild(next);
		block.finalize();
		composer.ui.requestRender(true);
		await terminal.waitForRender();
		const finalizedTape = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimStart());
		expect(lines.map(line => finalizedTape.filter(row => row === line).length)).toEqual(lines.map(() => 1));
		expect(finalizedTape.filter(row => row === "next live row")).toHaveLength(1);
		composer.ui.stop();
	});

	it("reports physically borrowed transcript ownership without retiring live blocks", async () => {
		const terminal = new CountingTerminal(80, 12);
		const composer = new Composer({ preferences: { ...config, quiet: true }, terminal });
		const transcript = new TranscriptContainer();
		const tall = new GrowingBlock();
		for (let index = 0; index < 30; index++) tall.append(`row ${index}`);
		const later = new GrowingBlock();
		later.append("still live");
		transcript.addChild(tall);
		transcript.addChild(later);
		composer.setRuntimeChildren([transcript, composer.editor]);
		composer.start();
		try {
			composer.ui.requestRender(true);
			await terminal.waitForRender();
			expect(transcript.isBlockUncommitted(tall)).toBe(false);
			expect(transcript.canRemoveBlock(tall)).toBe(false);
			expect(transcript.isBlockUncommitted(later)).toBe(true);
			expect(transcript.canRemoveBlock(later)).toBe(true);
			expect(transcript.blockStates()).toEqual(["active", "active"]);
		} finally {
			composer.stop();
		}
	});

	it("preserves every numbered row when the logical viewport grows beyond terminal height", async () => {
		const terminal = new CountingTerminal(80, 32);
		const composer = new Composer({ preferences: config, terminal });
		const transcript = new TranscriptContainer();
		const block = new GrowingBlock();
		transcript.addChild(block);
		composer.setRuntimeChildren([transcript, composer.editor]);
		composer.start();

		const lines = Array.from({ length: 60 }, (_value, index) => `${index + 1}. numbered row`);
		for (const line of lines) {
			block.append(line);
			composer.ui.requestRender(true);
			await terminal.waitForRender();
		}

		const tape = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimStart());
		const counts = lines.map(line => tape.filter(row => row === line).length);
		if (counts.some(count => count !== 1)) throw new Error(JSON.stringify(counts));

		const next = new GrowingBlock();
		next.append("next live row");
		transcript.addChild(next);
		block.finalize();
		composer.ui.requestRender(true);
		await terminal.waitForRender();
		const finalizedTape = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimStart());
		expect(lines.map(line => finalizedTape.filter(row => row === line).length)).toEqual(lines.map(() => 1));
		expect(finalizedTape.filter(row => row === "next live row")).toHaveLength(1);
		composer.ui.stop();
	});

	it("adopts the live draft with final theme, keybindings, and submit behavior", async () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		terminal.sendInput("alpha ");
		terminal.sendInput("\x1b[200~one\ntwo\x1b[201~");
		terminal.sendInput(" omega");
		terminal.sendInput("\x1b[D");

		const expectedDraft = composer.editor.getExpandedText();
		const expectedCursor = composer.editor.getCursor();
		const lease = new ComposerLease(composer);
		const adoptedComposer = lease.composer;
		const testSession = await createTestSession({
			inMemory: true,
			settingsOverrides: { symbolPreset: "ascii" },
		});
		let mode: InteractiveMode | undefined;

		try {
			await initTheme(false, "ascii");
			cfgComposerShape.set(settings, "box");
			vi.spyOn(KeybindingsManager, "create").mockReturnValue(KeybindingsManager.inMemory({ "app.clear": "ctrl+x" }));
			mode = new InteractiveMode(
				testSession.session,
				"test",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				adoptedComposer,
			);
			// Composer shape resolves through the session-scoped settings instance,
			// not the process-wide singleton.
			cfgComposerShape.set(mode.settings, "box");
			lease.adopt();
			vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

			expect(mode.ui).toBe(adoptedComposer.ui);
			expect(mode.editor).toBe(adoptedComposer.editor);
			await mode.init({ suppressWelcomeIntro: true });

			expect(mode.ui).toBe(adoptedComposer.ui);
			expect(mode.editor).toBe(adoptedComposer.editor);
			expect(mode.editor.getExpandedText()).toBe(expectedDraft);
			expect(mode.editor.getCursor()).toEqual(expectedCursor);
			expect(terminal.starts).toBe(1);
			const adoptedEditor = Bun.stripANSI(mode.editor.render(40).join("\n"));
			expect(adoptedEditor.startsWith("+")).toBe(true);
			expect(adoptedEditor).not.toContain("╭");

			terminal.sendInput("\x03");
			expect(mode.editor.getExpandedText()).toBe(expectedDraft);
			terminal.sendInput("\x18");
			expect(mode.editor.getExpandedText()).toBe("");
			expect(mode.editor.disableSubmit).toBe(false);
			terminal.sendInput("ready");
			expect(mode.editor.getExpandedText()).toBe("ready");

			const submitted = mode.getUserInput();
			expect(mode.editor.disableSubmit).toBe(false);
			terminal.sendInput("\r");
			expect(await submitted).toEqual(expect.objectContaining({ text: "ready" }));
			expect(mode.editor.getExpandedText()).toBe("");
			expect(terminal.starts).toBe(1);
		} finally {
			mode?.stop();
			await testSession.cleanup();
			vi.restoreAllMocks();
			await initTheme();
		}
	});

	it("keeps submit gated during initialization, then dispatches with steer", async () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease.composer,
		);
		lease.adopt();
		const enteredInit = Promise.withResolvers<void>();
		const releaseInit = Promise.withResolvers<void>();
		vi.spyOn(mode, "refreshSlashCommandState").mockImplementation(async () => {
			enteredInit.resolve();
			await releaseInit.promise;
		});
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		vi.spyOn(testSession.session, "maybeStartTitleGeneration").mockImplementation(() => {});
		const prompt = vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);

		try {
			const initializing = mode.init({ suppressWelcomeIntro: true });
			await enteredInit.promise;
			terminal.sendInput("alpha");
			terminal.sendInput("\r");

			expect(prompt).not.toHaveBeenCalled();
			expect(mode.editor.getExpandedText()).toBe("alpha");
			expect(mode.editor.disableSubmit).toBe(true);

			releaseInit.resolve();
			await initializing;
			// Init wired the submit pipeline and lifted the gate: an Enter before
			// the input loop's first getUserInput dispatches directly with steer
			// instead of being silently dropped.
			expect(mode.editor.disableSubmit).toBe(false);
			terminal.sendInput("\r");
			for (let i = 0; i < 50 && prompt.mock.calls.length === 0; i++) await Promise.resolve();
			expect(prompt).toHaveBeenCalledWith("alpha", expect.objectContaining({ streamingBehavior: "steer" }));
			expect(mode.editor.getExpandedText()).toBe("");
		} finally {
			releaseInit.resolve();
			mode.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("accepts input while the initial CLI prompt's first turn is still running", async () => {
		const terminal = new CountingTerminal();
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease.composer,
		);
		lease.adopt();
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		vi.spyOn(testSession.session, "maybeStartTitleGeneration").mockImplementation(() => {});
		const turn = Promise.withResolvers<boolean>();
		const prompt = vi.spyOn(testSession.session, "prompt").mockResolvedValue(true);

		try {
			await mode.init({ suppressWelcomeIntro: true });

			// The `omp "prompt"` launch shape: the CLI message is dispatched after
			// init and its first turn is still in flight when the user types. The
			// input loop has not reached getUserInput yet.
			prompt.mockReturnValueOnce(turn.promise);
			const initialTurn = testSession.session.prompt("count to 25", { streamingBehavior: "steer" });

			terminal.sendInput("also add tests");
			terminal.sendInput("\r");
			for (let i = 0; i < 50 && prompt.mock.calls.length < 2; i++) await Promise.resolve();
			expect(prompt).toHaveBeenCalledWith("also add tests", expect.objectContaining({ streamingBehavior: "steer" }));
			expect(mode.editor.getExpandedText()).toBe("");

			turn.resolve(true);
			await initialTurn;
		} finally {
			mode.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("tracks terminal ownership until a lease is adopted", () => {
		const abandonedTerminal = new CountingTerminal();
		const abandonedComposer = new Composer({ preferences: config, terminal: abandonedTerminal });
		abandonedComposer.start();
		const abandonedLease = new ComposerLease(abandonedComposer);
		abandonedLease.dispose();
		abandonedLease.dispose();
		expect(abandonedTerminal.stops).toBe(1);

		const adoptedTerminal = new CountingTerminal();
		const adoptedComposer = new Composer({ preferences: config, terminal: adoptedTerminal });
		adoptedComposer.start();
		const adoptedLease = new ComposerLease(adoptedComposer);
		adoptedLease.adopt();
		adoptedLease.dispose();
		expect(adoptedTerminal.stops).toBe(0);
		adoptedLease.composer.ui.stop();
		expect(adoptedTerminal.stops).toBe(1);
	});

	it("restores a partially started terminal and leaves no pending owner", () => {
		const terminal = new ThrowingStartTerminal();
		expect(() => beginStartupComposer({ preferences: config, terminal, cache: false })).toThrow(
			"terminal start failed",
		);
		expect(terminal.starts).toBe(1);
		expect(terminal.stops).toBe(1);
		expect(takeStartupComposerLease()).toBeUndefined();
	});

	it("bounds a tall startup draft after adoption in a short terminal", async () => {
		const terminal = new CountingTerminal(80, 8);
		const composer = new Composer({ preferences: config, terminal });
		composer.start();
		for (let index = 0; index < 18; index += 1) {
			terminal.sendInput(`line-${index}`);
			if (index < 17) terminal.sendInput("\n");
		}
		const draft = composer.editor.getExpandedText();
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		const mode = new InteractiveMode(
			testSession.session,
			"test",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease.composer,
		);
		lease.adopt();
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});

		try {
			await mode.init({ suppressWelcomeIntro: true });
			await terminal.waitForRender();
			expect(mode.editor.getExpandedText()).toBe(draft);
			expect(draft.split("\n")).toHaveLength(18);
			expect(mode.editor.render(80).length).toBeLessThanOrEqual(4);
			expect(terminal.getViewport().join("\n")).not.toContain("Starting OMP");
		} finally {
			mode.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("restores the terminal before an early double interrupt exits", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		let now = 1_000;
		const composer = new Composer({ preferences: config, terminal, exit, now: () => now });
		composer.start();

		terminal.sendInput("draft");
		terminal.sendInput("\x03");
		expect(composer.editor.getExpandedText()).toBe("");
		now += 100;
		terminal.sendInput("\x03");

		expect(terminal.stops).toBe(1);
		expect(exit).toHaveBeenCalledWith(130);
	});

	it("forward-deletes a startup draft before interactive keybindings load, exiting once it is empty", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		const composer = new Composer({ preferences: config, terminal, exit });
		composer.start();

		terminal.sendInput("draft");
		terminal.sendInput("\x1b[D"); // Left, so Ctrl+D has a character ahead of the cursor
		terminal.sendInput("\x04");
		expect(composer.editor.getExpandedText()).toBe("draf");
		expect(exit).not.toHaveBeenCalled();
		expect(terminal.stops).toBe(0);

		for (let i = 0; i < 4; i++) terminal.sendInput("\x7f"); // Backspace the rest of the draft
		expect(composer.editor.getExpandedText()).toBe("");
		terminal.sendInput("\x04");

		expect(exit).toHaveBeenCalledWith(0);
		expect(terminal.stops).toBe(1);
	});

	it("keeps emergency exit live after adoption until interactive handlers replace it", () => {
		const terminal = new CountingTerminal();
		const exit = vi.fn();
		const composer = new Composer({ preferences: config, terminal, exit });
		composer.start();
		const lease = new ComposerLease(composer);
		lease.adopt();

		// InputController.setupKeyHandlers() has not run yet; a stalled startup must
		// still honor Ctrl+D so a raw-mode user can abort.
		terminal.sendInput("\x04");

		expect(exit).toHaveBeenCalledWith(0);
		expect(terminal.stops).toBe(1);
	});

	it("renders the complete interactive welcome scene on the first frame", async () => {
		const terminal = new CountingTerminal(80, 32);
		const composer = new Composer({
			preferences: config,
			terminal,
			welcome: {
				version: "9.9.9",
				recentSessions: [{ name: "prior work", timeAgo: "5m ago" }],
			},
		});
		composer.start();
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Welcome back!")),
		);

		const output = terminal
			.getViewport()
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(output).toContain("Welcome back!");
		expect(output).toContain("omp");
		expect(output).toContain("9.9.9");
		expect(output).toContain("prior work");
		expect(output).not.toContain("Starting OMP");
		expect(output).toContain("╭");
		const initialEditorRow = terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.findLastIndex(row => row.startsWith("╭"));
		composer.updateWelcome({
			modelName: "provider/model-with-an-authoritative-name-that-is-longer-than-the-left-column",
			providerName: "provider-with-a-long-name",
			lspServers: [{ name: "rust-analyzer", status: "connecting", fileTypes: [".rs"] }],
		});
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("rust-analyzer")),
		);
		const updatedEditorRow = terminal
			.getViewport()
			.map(row => Bun.stripANSI(row))
			.findLastIndex(row => row.startsWith("╭"));
		expect(updatedEditorRow).toBe(initialEditorRow);
		composer.stop();
	});

	it("adopted welcome survives handoff with authoritative data", async () => {
		const terminal = new CountingTerminal(80, 32);
		const composer = new Composer({
			preferences: config,
			terminal,
			welcome: {
				version: "9.9.9",
				modelName: "Claude Fable 5",
				providerName: "anthropic",
				recentSessions: [{ name: "prior work", timeAgo: "5m ago" }],
			},
		});
		composer.start();
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Welcome back!")),
		);
		const prepaintRows = terminal.getViewport().map(row => Bun.stripANSI(row));
		expect(prepaintRows.join("\n")).toContain("Claude Fable 5");
		expect(prepaintRows.join("\n")).toContain("anthropic");
		const prepaintEditorRow = prepaintRows.findLastIndex(row => row.startsWith("╭"));

		terminal.sendInput("draft message");
		const lease = new ComposerLease(composer);
		const testSession = await createTestSession({ inMemory: true });
		let mode: InteractiveMode | undefined;

		try {
			mode = new InteractiveMode(
				testSession.session,
				"9.9.9",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				lease.composer,
			);
			lease.adopt();
			vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
			const realTopBorder = vi
				.spyOn(mode.statusLine, "getTopBorder")
				.mockReturnValue({ content: "real status bar", width: 15, revision: 1 });
			terminal.sendInput(" between");
			expect(mode.editor.getExpandedText()).toBe("draft message between");
			await terminal.waitForRender();
			await mode.init({ suppressWelcomeIntro: true });
			await terminal.waitForRender();

			expect(terminal.starts).toBe(1);
			expect(mode.editor.getExpandedText()).toBe("draft message between");
			const output = terminal
				.getViewport()
				.map(r => Bun.stripANSI(r))
				.join("\n");
			const modelName = testSession.session.model?.name ?? "";
			expect(output).toContain(modelName);
			realTopBorder.mockReturnValue({ content: "real status bar *18 ?5", width: 21, revision: 2 });
			mode.ui.requestRender();
			await terminal.waitForRender(() =>
				terminal.getViewport().some(row => Bun.stripANSI(row).includes("real status bar *18 ?5")),
			);
			const welcomeMatches = (output.match(/Welcome back!/g) || []).length;
			expect(welcomeMatches).toBe(1);
			const adoptedEditorRow = terminal
				.getViewport()
				.map(row => Bun.stripANSI(row))
				.findLastIndex(row => row.startsWith("╭"));
			expect(adoptedEditorRow).toBe(prepaintEditorRow);
		} finally {
			mode?.stop();
			lease.dispose();
			await testSession.cleanup();
			vi.restoreAllMocks();
		}
	});

	it("preferences feed applies quiet mode", async () => {
		const terminal = new CountingTerminal(80, 32);
		beginStartupComposer({
			preferences: config,
			terminal,
			version: "9.9.9",
			cache: false,
		});
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Welcome back!")),
		);
		expect(
			terminal
				.getViewport()
				.map(r => Bun.stripANSI(r))
				.join("\n"),
		).toContain("Welcome back!");

		applyStartupComposerPreferences({
			quiet: true,
			composerShape: "box",
			showHardwareCursor: config.showHardwareCursor,
			maxInlineImages: config.maxInlineImages,
			resizeScrollback: config.resizeScrollback,
			imeSafeCursor: config.imeSafeCursor,
			autocompleteMaxVisible: config.autocompleteMaxVisible,
			spellingTypoDetection: cfgSpellingTypoDetection.get(settings),
			spellingAutocomplete: cfgSpellingAutocomplete.get(settings),
			spellingAutocorrect: cfgSpellingAutocorrect.get(settings),
			theme: {},
		});
		await terminal.waitForRender();

		const output = terminal
			.getViewport()
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(output).not.toContain("Welcome back!");

		terminal.sendInput("still editable");
		await terminal.waitForRender();
		expect(
			terminal
				.getViewport()
				.map(r => Bun.stripANSI(r))
				.join("\n"),
		).toContain("still editable");
	});

	it("LSP feed fills the welcome rows", async () => {
		const terminal = new CountingTerminal(80, 32);
		beginStartupComposer({
			preferences: config,
			terminal,
			version: "9.9.9",
			cache: false,
		});
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("Welcome back!")),
		);

		setStartupComposerLspServers([{ name: "rust-analyzer", status: "connecting", fileTypes: [".rs"] }]);
		await terminal.waitForRender(() =>
			terminal.getViewport().some(row => Bun.stripANSI(row).includes("rust-analyzer")),
		);

		const output = terminal
			.getViewport()
			.map(r => Bun.stripANSI(r))
			.join("\n");
		expect(output).toContain("rust-analyzer");
	});
	it("starts recent-session I/O only after the prepaint turn and transfers it across ownership", async () => {
		const terminal = new CountingTerminal(80, 32);
		const load = Promise.withResolvers<Array<{ name: string; timeAgo: string }>>();
		let calls = 0;
		beginStartupComposer({
			preferences: config,
			terminal,
			version: "9.9.9",
			cache: false,
			recentSessions: () => {
				calls++;
				return load.promise;
			},
		});

		expect(calls).toBe(0);
		const lease = takeStartupComposerLease();
		expect(lease).toBeDefined();
		const updateWelcome = vi.spyOn(lease!.composer, "updateWelcome");
		lease?.dispose();
		const rows = [{ name: "already loading", timeAgo: "just now" }];
		load.resolve(rows);
		expect(await lease?.recentSessions).toEqual(rows);
		expect(calls).toBe(1);
		expect(updateWelcome).not.toHaveBeenCalled();
	});
	it("defers raw input until resolved settings arrive, adoption as fallback", async () => {
		// Regression contract: losing the deferral re-blinds typing during the
		// startup module-load stall; losing the enable leaves the keyboard dead
		// for the whole session.
		const terminal = new InputTrackingTerminal(80, 32);
		beginStartupComposer({ preferences: config, terminal, version: "9.9.9", cache: false });
		// The prepaint must be physically written before any async runtime import
		// can monopolize the event loop; a merely queued render is still a blind gap.
		expect(terminal.getViewport().some(row => Bun.stripANSI(row).includes("9.9.9"))).toBeTrue();
		expect(terminal.startOptions?.deferInput).toBeTrue();
		expect(terminal.inputEnables).toBe(0);

		applyStartupComposerPreferences({ ...config, theme: {} });
		expect(terminal.inputEnables).toBe(1);

		// Adoption after preferences must not double-enable…
		const lease = takeStartupComposerLease();
		lease?.adopt();
		expect(terminal.inputEnables).toBe(1);
		lease?.composer.ui.stop();
	});

	it("adoption enables raw input when settings never resolved", () => {
		const terminal = new InputTrackingTerminal(80, 32);
		beginStartupComposer({ preferences: config, terminal, version: "9.9.9", cache: false });
		const lease = takeStartupComposerLease();
		lease?.adopt();
		expect(terminal.inputEnables).toBe(1);
		lease?.composer.ui.stop();
	});

	it("publishes row ownership so right-side widgets paint in header rows", async () => {
		// Regression: without per-row segments in the frame plan, every targeted
		// row is ineligible and extension right widgets never paint (#right-panel).
		const terminal = new CountingTerminal(100, 30);
		const composer = new Composer({ preferences: config, terminal });
		composer.ui.setRightPanel(() => [["<WIDGET-0>"]], [composer.rightPanelHeaderTarget]);
		composer.start();
		try {
			await terminal.waitForRender(() =>
				terminal.getViewport().some(row => Bun.stripANSI(row).includes("<WIDGET-0>")),
			);
			expect(terminal.getViewport().some(row => Bun.stripANSI(row).includes("<WIDGET-0>"))).toBeTrue();
		} finally {
			composer.ui.stop();
		}
	});
});
