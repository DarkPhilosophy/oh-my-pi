import { describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class Card implements Component {
	lines: string[];
	finalized = false;
	version = 1;
	constructor(lines: string[]) {
		this.lines = lines;
	}
	getTranscriptBlockVersion = () => this.version;
	render(width: number): readonly string[] {
		return this.lines.map(line => line.slice(0, width));
	}
	isTranscriptBlockFinalized(): boolean {
		return this.finalized;
	}
}

const BOTTOM = "╰────────╯";

// A card exactly as tall as the viewport lends all of its rows to scrollback
// but not the blank separating it from the next block. Retirement used to
// treat the fully borrowed card as contributing nothing — including that
// separator — so every following card was glued onto the previous one.
describe("transcript separators after fully borrowed cards", () => {
	for (const [rows, body] of [
		[5, 3],
		[8, 6],
		[6, 1],
		[10, 12],
	] as const) {
		it(`keeps every separator (viewport ${rows}, body ${body})`, async () => {
			const term = new VirtualTerminal(40, rows);
			Object.defineProperty(term, "isNativeViewportAtBottom", { configurable: true, value: () => undefined });
			const scheduler = new StressRenderScheduler();
			const composer = new Composer({
				terminal: term,
				preferences: { quiet: true },
				tuiOptions: { renderScheduler: scheduler },
			});
			const chat = new TranscriptContainer();
			composer.setRuntimeChildren([chat]);
			composer.start({ playWelcomeIntro: false });
			await scheduler.drain(term);
			const expected: string[] = [];
			for (let n = 0; n < 6; n++) {
				const card = new Card([`╭ c${n} ╮`]);
				chat.addChild(card);
				for (let grow = 1; grow <= body; grow++) {
					card.lines = [`╭ c${n} ╮`, ...Array.from({ length: grow }, (_, i) => `│ c${n}-${i} │`), BOTTOM];
					card.version++;
					composer.ui.requestRender();
					await scheduler.drain(term);
				}
				card.finalized = true;
				card.version++;
				expected.push(...card.lines, "");
				composer.ui.requestRender();
				await scheduler.drain(term);
			}
			await term.flush();
			const tape = [...term.getScrollBuffer(), ...term.getViewport()].map(row => Bun.stripANSI(row).trimEnd());
			composer.stop();
			const start = tape.indexOf(expected[0]!);
			// The last card may still be live without its trailing separator.
			const settled = expected.slice(0, -1);
			expect(tape.slice(start, start + settled.length)).toEqual(settled);
		});
	}
});
