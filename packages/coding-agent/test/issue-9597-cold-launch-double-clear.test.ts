import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ComposerPreferences } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	beginStartupComposer,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "@oh-my-pi/pi-coding-agent/modes/startup-composer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { type Component, Text } from "@oh-my-pi/pi-tui";
import { withoutTerminalMultiplexer } from "../../tui/test/helpers/terminal-multiplexer";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { assistantMsg, createTestSession, userMsg } from "./utilities";

// Every destructive reset emits one erase-scrollback (ED3). Count that
// operation without coupling this regression to the ED2/ED3 ordering.
const ERASE_SCROLLBACK = "\x1b[3J";

/** VirtualTerminal that also records every raw byte the TUI writes. */
class CapturingTerminal extends VirtualTerminal {
	readonly raw: string[] = [];
	override write(data: string): void {
		this.raw.push(data);
		super.write(data);
	}
	countResets(): number {
		const all = this.raw.join("");
		let n = 0;
		for (let i = all.indexOf(ERASE_SCROLLBACK); i !== -1; i = all.indexOf(ERASE_SCROLLBACK, i + 1)) n++;
		return n;
	}
}

// Cold launch first clears native history while painting the prepaint welcome.
// Once InteractiveMode is ready, a normal replay can offer resumed transcript
// rows and repaint the viewport without another destructive reset. On conhost a
// second ED3-then-ED2 reset would archive the prepaint frame into scrollback
withoutTerminalMultiplexer();
// after ED3 already ran, leaving a stale welcome above the live UI (issue #9597).
describe("issue #9597 — cold-launch welcome duplication", () => {
	let settings: Settings;
	let config: ComposerPreferences;

	beforeEach(async () => {
		resetSettingsForTest();
		await initTheme();
		settings = await Settings.init({ inMemory: true });
		config = {
			quiet: settings.get("startup.quiet"),
			composerShape: settings.get("composer.shape") ?? "box",
			showHardwareCursor: settings.get("showHardwareCursor"),
			maxInlineImages: settings.get("tui.maxInlineImages"),
			resizeScrollback: settings.get("tui.resizeScrollback"),
			scrollbackRebuild: settings.get("tui.scrollbackRebuild"),
			imeSafeCursor: settings.get("tui.imeSafeCursor"),
			autocompleteMaxVisible: settings.get("autocompleteMaxVisible"),
			spellingTypoDetection: settings.get("spelling.typoDetection"),
			spellingAutocomplete: settings.get("spelling.autocomplete"),
			spellingAutocorrect: settings.get("spelling.autocorrect"),
		};
	});

	afterEach(() => {
		stopPendingStartupComposer();
		resetSettingsForTest();
	});

	// `resuming` mirrors `main.ts` `runInteractiveMode`: `false` on a plain `omp`
	// launch, `true` for --continue/--resume/--fork.
	async function coldLaunch(
		resuming: boolean,
		options: { priorPaneMarker?: string; preserveExistingChat?: boolean; staleMarker?: string } = {},
	): Promise<{
		resets: number;
		welcomeRows: number;
		scrollBuffer: string;
		staleRetained: boolean;
	}> {
		const preserveExistingChat = options.preserveExistingChat ?? true;
		const terminal = new CapturingTerminal(100, 30);
		if (options.priorPaneMarker) {
			terminal.write(`${options.priorPaneMarker}\r\n`);
		}
		beginStartupComposer({ preferences: config, terminal, version: "18.0.4", cache: false });
		await terminal.waitForRender();
		const lease = takeStartupComposerLease();
		expect(lease).toBeDefined();
		const testSession = await createTestSession({ inMemory: true });
		if (resuming) {
			testSession.sessionManager.appendMessage(userMsg("resume marker question"));
			testSession.sessionManager.appendMessage(assistantMsg("resume marker answer"));
		}
		const mode = new InteractiveMode(
			testSession.session,
			"18.0.4",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			lease!.composer,
		);
		lease!.adopt();
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		try {
			await mode.init({ suppressWelcomeIntro: resuming, clearInitialTerminalHistory: true });
			await terminal.waitForRender();
			let stale: Component | undefined;
			if (options.staleMarker) {
				stale = new Text(options.staleMarker);
				mode.chatContainer.addChild(stale);
			}
			await mode.renderInitialMessages({
				preserveExistingChat,
				clearTerminalHistory: resuming,
			});
			// The replay rebuild paints in idle chunks after the promise resolves;
			// settle on the frame that actually shows the replayed transcript.
			await terminal.waitForRender(
				() =>
					!resuming ||
					terminal.getScrollBuffer().some(line => Bun.stripANSI(line).includes("resume marker answer")),
			);
			const rows = terminal.getScrollBuffer().map(l => Bun.stripANSI(l));
			return {
				resets: terminal.countResets(),
				welcomeRows: rows.filter(l => l.includes("18.0.4")).length,
				scrollBuffer: rows.join("\n"),
				staleRetained: stale !== undefined && mode.chatContainer.children.includes(stale),
			};
		} finally {
			mode.stop();
			await testSession.cleanup();
		}
	}

	it("clears native history once on a fresh launch, leaving one welcome header", async () => {
		const { resets, welcomeRows } = await coldLaunch(false);
		// The first clear already owns the final welcome frame; the replay must not
		// clear again, or conhost promotes that frame into scrollback (duplicate).
		expect(resets).toBe(1);
		expect(welcomeRows).toBe(1);
	});

	it("lets the resumed replay own an authoritative clear so history reaches scrollback", async () => {
		const { resets, scrollBuffer } = await coldLaunch(true);
		// The replay repaints the whole transcript as real lines; without its own
		// clear it repaints in place and the history never enters scrollback.
		expect(resets).toBe(2);
		expect(scrollBuffer).toContain("resume marker answer");
	});

	it("clears stale pane history before replaying --resume inside tmux", async () => {
		const previousTmux = Bun.env.TMUX;
		Bun.env.TMUX = "/tmp/tmux-test/default,1,0";
		try {
			const { resets, scrollBuffer } = await coldLaunch(true, {
				priorPaneMarker: "PREVIOUS_RESUME_SESSION_MARKER",
			});
			expect(resets).toBe(2);
			expect(scrollBuffer).not.toContain("PREVIOUS_RESUME_SESSION_MARKER");
			expect(scrollBuffer).toContain("resume marker answer");
		} finally {
			if (previousTmux === undefined) delete Bun.env.TMUX;
			else Bun.env.TMUX = previousTmux;
		}
	});

	// Cold `--resume` (main.ts) passes `preserveExistingChat: true`, while the
	// in-process `/resume` passes `false`. Both must reach native scrollback with
	// the resumed transcript; only the preserving variant keeps prior components.
	it("reaches native scrollback on both resume paths and only preserves prior chat when asked", async () => {
		const cold = await coldLaunch(true, { preserveExistingChat: true, staleMarker: "STALE_CHAT_COMPONENT" });
		expect(cold.scrollBuffer).toContain("resume marker answer");
		expect(cold.staleRetained).toBeTrue();

		const inProcess = await coldLaunch(true, { preserveExistingChat: false, staleMarker: "STALE_CHAT_COMPONENT" });
		expect(inProcess.scrollBuffer).toContain("resume marker answer");
		expect(inProcess.staleRetained).toBeFalse();
	});
});
