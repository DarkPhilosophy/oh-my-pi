import { afterEach, beforeAll, expect, it, vi } from "bun:test";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Text } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();
beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
it("makes an oversized startup changelog available in scrollback after the intro without input", async () => {
	const terminal = new VirtualTerminal(100, 30);
	vi.useFakeTimers();
	let now = 0;
	vi.spyOn(performance, "now").mockImplementation(() => now);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { spellingTypoDetection: false, spellingAutocomplete: false, spellingAutocorrect: false },
	});
	const entries = Array.from({ length: 60 }, (_, i) => `Changelog entry ${i}`);
	composer.setHeaderExtras([], [new Text(entries.join("\n"), 0, 0)]);
	composer.setRuntimeChildren([new TranscriptContainer(), new Text("EDITOR", 0, 0)]);
	composer.start();
	try {
		await scheduler.settle(terminal);
		// Complete the intro with no key or unrelated render to rescue its
		// completion frame.
		now = 3200;
		vi.advanceTimersByTime(33);
		await scheduler.settle(terminal);
		const rows = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
		expect(rows.filter(row => row.startsWith("Changelog entry "))).toEqual(entries);
		expect(terminal.getViewport().at(-1)?.trimEnd()).toBe("EDITOR");
	} finally {
		composer.stop();
	}
});

it("keeps the welcome on screen when a multi-line draft grows the editor", async () => {
	const probe = new VirtualTerminal(60, 200);
	const scheduler = new VirtualRenderScheduler();
	const measure = new Composer({
		terminal: probe,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { spellingTypoDetection: false, spellingAutocomplete: false, spellingAutocorrect: false },
	});
	measure.setRuntimeChildren([new TranscriptContainer(), new Text("EDITOR", 0, 0)]);
	measure.start();
	await scheduler.settle(probe);
	const headerRows = probe.getViewport().filter(row => row.trim().length > 0).length - 1;
	measure.stop();

	// Header + one live notice + a one-line editor fill the screen exactly.
	const terminal = new VirtualTerminal(60, headerRows + 3);
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { spellingTypoDetection: false, spellingAutocomplete: false, spellingAutocorrect: false },
	});
	const transcript = new TranscriptContainer();
	const editor = new Text("EDITOR", 0, 0);
	composer.setRuntimeChildren([transcript, editor], { transient: [editor] });
	composer.start();
	try {
		transcript.addChild(new Text("Session-only model: x.", 0, 0));
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		expect(terminal.getViewport().some(row => row.includes("Welcome"))).toBe(true);

		editor.setText("EDITOR\nsecond line");
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		editor.setText("EDITOR");
		composer.ui.requestRender();
		await scheduler.settle(terminal);

		// The draft grew and shrank back: the welcome must still be painted,
		// not archived to scrollback above a blank screen.
		expect(terminal.getViewport().some(row => row.includes("Welcome"))).toBe(true);
	} finally {
		composer.stop();
	}
});
