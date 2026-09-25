import { describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const WINDOW = 6;
const LINES = 12;

/** A streaming write preview: header, tail window of the last lines, status footer. */
class WriteCard implements Component {
	total = 0;
	finalized = false;
	version = 0;
	constructor(readonly tag: string) {}
	getTranscriptBlockVersion = () => this.version;
	render(): readonly string[] {
		const start = Math.max(0, this.total - WINDOW);
		const rows = [`╭ ${this.tag} ╮`];
		if (start > 0) rows.push(`… (${start} earlier lines)`);
		for (let i = start; i < this.total; i++) rows.push(`${this.tag} ${i + 1}`);
		rows.push(this.finalized ? `╰ ${this.tag} done ╯` : `╰ ${this.tag} streaming ╯`);
		return rows;
	}
	isTranscriptBlockFinalized(): boolean {
		return this.finalized;
	}
}

// Parallel tool calls stream several previews at once: earlier cards scroll
// into native scrollback while they still change (tail window, status footer).
// Those borrowed rows are immutable; re-emitting a changed row landed it below
// every later card — stray footers and whole duplicated cards in scrollback.
describe("parallel streaming previews", () => {
	for (const rows of [10, 14, 20]) {
		it(`keeps cards whole and in order (viewport ${rows})`, async () => {
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
			const cards: WriteCard[] = [];
			for (let n = 0; n < 5; n++) {
				const card = new WriteCard(`w${n}`);
				cards.push(card);
				chat.addChild(card);
				for (let line = 0; line < LINES; line++) {
					card.total++;
					card.version++;
					composer.ui.requestRender();
					await scheduler.drain(term);
				}
			}
			for (const card of cards) {
				card.finalized = true;
				card.version++;
				composer.ui.requestRender();
				await scheduler.drain(term);
			}
			await term.flush();
			const tape = term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				// A card that scrolled off while streaming keeps its stale footer.
				.map(row => row.replace(/^(╰ w\d) (streaming|done) ╯$/, "$1 ╯"));
			composer.stop();
			const expected: string[] = [];
			for (const card of cards) {
				expected.push(...card.render().map(row => row.replace(/^(╰ w\d) done ╯$/, "$1 ╯")), "");
			}
			expected.pop();
			const start = tape.indexOf("╭ w0 ╮");
			expect(tape.slice(start, start + expected.length)).toEqual(expected);
			expect(tape.slice(start + expected.length).filter(row => row !== "")).toEqual([]);
		});
	}
});
