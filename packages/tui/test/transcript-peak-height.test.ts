import { beforeAll, describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

/** A live tool card whose body streams up, collapses to an error, then finishes. */
class MutableCard {
	rows: string[] = ["header"];
	finalized = false;
	render(): string[] {
		return this.rows;
	}
	isTranscriptBlockFinalized(): boolean {
		return this.finalized;
	}
	isTranscriptBlockTransient(): boolean {
		return !this.finalized;
	}
	setTranscriptAllocation(): void {}
}

const frame = { now: 0, tick: 0 };

beforeAll(async () => {
	await initTheme();
});

describe("live block peak height", () => {
	it("never lets a live card shrink, and measurement agrees with the viewport", () => {
		const transcript = new TranscriptContainer();
		const card = new MutableCard();
		transcript.addChild(card);

		const heightOf = (): { measured: number; shown: number } => {
			const measured = transcript.transientBlocks(80, 40, frame).reduce((sum, block) => sum + block.rows, 0);
			const shown = transcript.renderViewport(80, 40, frame).length;
			return { measured, shown };
		};

		// Grows to 12 rows while streaming.
		card.rows = Array.from({ length: 12 }, (_, i) => `line ${i}`);
		expect(heightOf()).toEqual({ measured: 12, shown: 12 });

		// Regression: the tool fails and its card collapses to a 4-row error.
		// The live region used to contract by 8 rows here - and grow back on
		// the next tool - moving everything below it every time.
		card.rows = ["header", "error: boom", "", "detail"];
		expect(heightOf()).toEqual({ measured: 12, shown: 12 });

		// Growing past the peak raises it; the card still never goes down.
		card.rows = Array.from({ length: 15 }, (_, i) => `line ${i}`);
		expect(heightOf()).toEqual({ measured: 15, shown: 15 });
		card.rows = ["header", "done"];
		expect(heightOf()).toEqual({ measured: 15, shown: 15 });

		// Finishing must not lower it either: a completed card keeps the size
		// it had while running for as long as it stays in the live region, and
		// the planner's reservation must agree with what the viewport shows.
		card.finalized = true;
		expect(heightOf()).toEqual({ measured: 15, shown: 15 });
	});

	it("forgets the peak when the terminal width changes", () => {
		const transcript = new TranscriptContainer();
		const card = new MutableCard();
		transcript.addChild(card);
		card.rows = Array.from({ length: 10 }, (_, i) => `line ${i}`);
		expect(transcript.renderViewport(40, 40, frame)).toHaveLength(10);
		card.rows = ["header", "short"];
		// A narrower reflow could have inflated the peak; a new width starts over.
		expect(transcript.renderViewport(120, 40, frame)).toHaveLength(2);
	});
});
