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

describe("live block height measurement", () => {
	it("remeasures a changing card without retaining stale blank padding", () => {
		const transcript = new TranscriptContainer();
		const card = new MutableCard();
		transcript.addChild(card);

		const heightOf = (): { measured: number; shown: number } => {
			const measured = transcript.liveRowCount(80);
			const shown = transcript.renderViewport(80, 40, frame).length;
			return { measured, shown };
		};

		// Grows to 12 rows while streaming.
		card.rows = Array.from({ length: 12 }, (_, i) => `line ${i}`);
		expect(heightOf()).toEqual({ measured: 12, shown: 12 });

		// A shorter result must not preserve the previous preview's empty footprint.
		card.rows = ["header", "error: boom", "", "detail"];
		expect(heightOf()).toEqual({ measured: 4, shown: 4 });

		// Subsequent growth and shrinkage both use the current content height.
		card.rows = Array.from({ length: 15 }, (_, i) => `line ${i}`);
		expect(heightOf()).toEqual({ measured: 15, shown: 15 });
		card.rows = ["header", "done"];
		expect(heightOf()).toEqual({ measured: 2, shown: 2 });

		// Finalization preserves the measured body rather than adding a stale peak.
		card.finalized = true;
		expect(heightOf()).toEqual({ measured: 2, shown: 2 });
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
