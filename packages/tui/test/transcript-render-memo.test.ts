import { beforeAll, describe, expect, it } from "bun:test";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

/** A live mutable block that counts how often the composer asks it to render. */
class CountingBlock {
	renders = 0;
	rows = 5;
	render(): string[] {
		this.renders++;
		return Array.from({ length: this.rows }, (_, i) => `live row ${i}`);
	}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	setTranscriptAllocation(): void {}
}

beforeAll(async () => {
	await initTheme();
});

describe("transcript per-frame render memo", () => {
	it("renders a live block once per composed frame, not once per walk", async () => {
		const terminal = new VirtualTerminal(80, 30);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		for (let i = 0; i < 20; i++) transcript.addChild({ render: () => [`settled ${i}`] });
		const block = new CountingBlock();
		transcript.addChild(block);
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, editor]);
		composer.start({ playWelcomeIntro: false });
		try {
			await scheduler.settle(terminal);
			const afterFirst = block.renders;
			// Regression: composition walks the live entries several times per
			// paint (transient measurement, viewport render, history offer), and
			// each walk used to render every live block again. On a long
			// session that multiplied a frame's cost and froze the UI.
			expect(afterFirst).toBeGreaterThan(0);
			expect(afterFirst).toBeLessThanOrEqual(2);

			// A new frame must render again: the memo is per paint, never
			// across paints, so a changed block is always shown current.
			block.rows = 6;
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			expect(block.renders).toBeGreaterThan(afterFirst);
			expect(block.renders - afterFirst).toBeLessThanOrEqual(2);
			const viewport = terminal.getViewport().map(line => Bun.stripANSI(line).trimEnd());
			expect(viewport.filter(line => line.startsWith("live row"))).toHaveLength(6);
		} finally {
			composer.stop();
		}
	});
});
