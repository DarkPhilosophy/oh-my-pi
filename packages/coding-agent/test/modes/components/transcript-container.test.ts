import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import type { Component } from "@oh-my-pi/pi-tui";

class Block implements Component {
	#rows: string[];
	#finalized: boolean;
	allocations: number[] = [];

	constructor(rows: string[], finalized: boolean) {
		this.#rows = rows;
		this.#finalized = finalized;
	}

	finalize(rows: string[]): void {
		this.#rows = rows;
		this.#finalized = true;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	setTranscriptAllocation(rows: number): void {
		this.allocations.push(rows);
	}

	render(): readonly string[] {
		return this.#rows;
	}

	getTranscriptBlockSettledRows(): number {
		return 0;
	}

	setSettledRows(n: number): void {
		this.getTranscriptBlockSettledRows = () => n;
	}
}
class SettledRowsBlock extends Block {
	constructor(
		rows: string[],
		readonly settledRows: number,
	) {
		super(rows, false);
	}

	override getTranscriptBlockSettledRows(): number {
		return this.settledRows;
	}
}

class AllocationAwareBlock implements Component {
	#allocation = Number.MAX_SAFE_INTEGER;
	#finalized = false;

	constructor(private readonly rows: readonly string[]) {}

	finalize(): void {
		this.#finalized = true;
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	setTranscriptAllocation(rows: number): void {
		this.#allocation = rows;
	}

	render(): readonly string[] {
		return this.rows.slice(-this.#allocation);
	}
}

const frame = { tick: 0, now: 0 };

describe("TranscriptContainer", () => {
	it("keeps allocation-aware live blocks intact in the logical viewport", () => {
		const transcript = new TranscriptContainer();
		const rows = Array.from({ length: 8 }, (_, index) => `row-${index}`);
		const block = new AllocationAwareBlock(rows);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 3, frame)).toEqual(rows);
		block.finalize();
		expect(transcript.peekFinalizedBatch(80, 0)?.rows).toEqual([...rows, ""]);
	});
	it("protects physically borrowed blocks without freezing later live blocks", () => {
		const transcript = new TranscriptContainer();
		const borrowed = new Block(["first", "second"], false);
		const live = new Block(["later"], false);
		transcript.addChild(borrowed);
		transcript.addChild(live);
		transcript.renderViewport(40, 10, frame);
		transcript.setBorrowedViewportRows(1);
		expect(transcript.isBlockUncommitted(borrowed)).toBe(false);
		expect(transcript.canRemoveBlock(borrowed)).toBe(false);
		expect(transcript.isBlockUncommitted(live)).toBe(true);
		expect(transcript.canRemoveBlock(live)).toBe(true);
		transcript.removeChild(borrowed);
		transcript.removeChild(live);
		expect(transcript.children).toEqual([borrowed]);
	});

	it("retains only the actual borrowed rows of surviving owners after finalized drift", () => {
		for (const borrowedRows of [2, 4]) {
			const transcript = new TranscriptContainer();
			const finalized = new Block(["old", "same"], false);
			const live = new Block(["same", "live", "editor"], false);
			transcript.addChild(finalized);
			transcript.addChild(live);
			transcript.renderViewport(80, 10, frame);
			transcript.setBorrowedViewportRows(borrowedRows);
			finalized.finalize(["new", "same"]);
			const history = transcript.peekFinalizedBatch(80, 0);
			expect(history?.rows).toEqual(["new", "same", ""]);
			expect(transcript.renderViewport(80, 10, frame)).toEqual(["same", "live", "editor"]);
			expect(transcript.borrowedViewportRowCount()).toBe(borrowedRows === 4 ? 1 : 0);
			expect(transcript.canRemoveBlock(live)).toBe(borrowedRows === 2);
		}
	});

	it("captures mutable by default and append-only declarations permanently", () => {
		const transcript = new TranscriptContainer();
		const borrowed = new Block(["first", "second"], false);
		const live = new Block(["later"], false);
		transcript.addChild(borrowed);
		transcript.addChild(live);
		transcript.renderViewport(40, 10, frame);
		transcript.setBorrowedViewportRows(1);
		expect(transcript.isBlockUncommitted(borrowed)).toBe(false);
		expect(transcript.canRemoveBlock(borrowed)).toBe(false);
		expect(transcript.isBlockUncommitted(live)).toBe(true);
		expect(transcript.canRemoveBlock(live)).toBe(true);
		transcript.removeChild(borrowed);
		transcript.removeChild(live);
		expect(transcript.children).toEqual([borrowed]);
	});

	it("keeps settled blocks live while the viewport has room", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled"], true));
		transcript.addChild(new Block(["streaming"], false));

		// Both fit: nothing retires, the settled block still renders live.
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["settled", "", "streaming"]);
	});

	it("does not retire the still-visible part of a resumed settled block", () => {
		const transcript = new TranscriptContainer();
		const rows = Array.from({ length: 40 }, (_, index) => `answer-${index}`);
		transcript.addChild(new Block(rows, true));
		expect(transcript.peekFinalizedBatch(80, 30)).toBeUndefined();
		expect(transcript.renderViewport(80, 30, frame).slice(-30)).toEqual(rows.slice(-30));
		expect(transcript.peekFinalizedBatch(80, 30)).toBeUndefined();
	});

	it("publishes only the offscreen portion of a settled row prefix", () => {
		const transcript = new TranscriptContainer();
		const rows = Array.from({ length: 40 }, (_, index) => `answer-${index}`);
		const block = new Block(rows, false);
		block.setSettledRows(40);
		transcript.addChild(block);
		const batch = transcript.peekFinalizedBatch(80, 30);
		expect(batch?.rows).toEqual(rows.slice(0, 10));
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.renderViewport(80, 30, frame)).toEqual(rows.slice(10));
		expect(transcript.peekFinalizedBatch(80, 30)).toBeUndefined();
	});

	it("replays a mutable settled prefix before rendering its live suffix", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(
			Array.from({ length: 40 }, (_value, index) => `row-${index}`),
			false,
		);
		block.setSettledRows(40);
		transcript.addChild(block);

		const first = transcript.peekFinalizedBatch(80, 30);
		expect(first?.rows).toEqual(Array.from({ length: 10 }, (_value, index) => `row-${index}`));
		transcript.acknowledgeFinalizedBatch(first!.id);
		expect(transcript.renderViewport(80, 30, frame)).toEqual(
			Array.from({ length: 30 }, (_value, index) => `row-${index + 10}`),
		);

		transcript.beginReplay();
		const replay = transcript.peekReplayBatch(80);
		expect(replay?.rows).toEqual(Array.from({ length: 10 }, (_value, index) => `row-${index}`));
		expect(transcript.renderViewport(80, 30, frame)).toEqual(
			Array.from({ length: 30 }, (_value, index) => `row-${index + 10}`),
		);
		transcript.acknowledgeFinalizedBatch(replay!.id);
		expect(transcript.peekReplayBatch(80)).toBeUndefined();
		expect(transcript.renderViewport(80, 30, frame)).toEqual(
			Array.from({ length: 30 }, (_value, index) => `row-${index + 10}`),
		);
	});

	it("retires the settled prefix only under capacity pressure, in order", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["first final"], true);
		const second = new Block(["second live", "row", "row"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		// 5 rows fit everything (1 + separator + 3).
		expect(transcript.peekFinalizedBatch(80, 5)).toBeUndefined();
		// 3 rows force the settled prefix out.
		expect(transcript.peekFinalizedBatch(80, 3)?.rows).toEqual(["first final", ""]);
	});

	it("never retires a finalized successor past an active predecessor", () => {
		const transcript = new TranscriptContainer();
		const active = new Block(["active live"], false);
		const settled = new Block(["settled final"], true);
		transcript.addChild(active);
		transcript.addChild(settled);

		// Pressure exists but the prefix starts with an active block: no batch,
		// and both blocks still render (clipped by the viewport).
		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["active live", "", "settled final"]);

		active.finalize(["active final"]);
		// Capacity 1 fits the remaining settled block, so only the first retires.
		expect(transcript.peekFinalizedBatch(80, 1)?.rows).toEqual(["active final", ""]);
	});

	it("reoffers an unacknowledged batch and retires it exactly once", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final one"], true));
		transcript.addChild(new Block(["final two"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		const second = transcript.peekFinalizedBatch(80, 50);

		expect(second).toEqual(first);
		if (first === undefined) throw new Error("expected a batch under zero capacity");
		transcript.acknowledgeFinalizedBatch(first.id);
		// Committed blocks leave the live tail and never render again.
		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
	});

	it("excludes an offered batch from the live viewport in the same frame", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["old settled"], true));
		transcript.addChild(new Block(["fresh live"], false));

		const batch = transcript.peekFinalizedBatch(80, 1);
		expect(batch?.rows).toEqual(["old settled", ""]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["fresh live"]);
	});

	it("preserves every logical row when live content exceeds terminal capacity", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(["A1", "A2", "A3", "A4"], false);
		transcript.addChild(block);

		expect(transcript.renderViewport(80, 2, frame)).toEqual(["A1", "A2", "A3", "A4"]);
		block.finalize(["A1", "A2", "A3", "A4"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["A1", "A2", "A3", "A4"]);
	});
	it("keeps a tall finalized block live when its visible tail still fits", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(
			Array.from({ length: 40 }, (_value, index) => `row-${index}`),
			true,
		);
		transcript.addChild(block);

		expect(transcript.peekFinalizedBatch(80, 30)).toBeUndefined();
		expect(transcript.renderViewport(80, 30, frame)).toHaveLength(40);
	});

	it("emits only the settled prefix that actually overflows", () => {
		const transcript = new TranscriptContainer();
		const block = new SettledRowsBlock(
			Array.from({ length: 40 }, (_value, index) => `row-${index}`),
			40,
		);
		transcript.addChild(block);

		const batch = transcript.peekFinalizedBatch(80, 30);
		expect(batch?.rows).toEqual(Array.from({ length: 10 }, (_value, index) => `row-${index}`));
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.renderViewport(80, 30, frame)).toEqual(
			Array.from({ length: 30 }, (_value, index) => `row-${index + 10}`),
		);
	});

	it("replays a mutable settled prefix before rendering its live suffix", () => {
		const transcript = new TranscriptContainer();
		const block = new SettledRowsBlock(
			Array.from({ length: 40 }, (_value, index) => `row-${index}`),
			40,
		);
		transcript.addChild(block);

		const first = transcript.peekFinalizedBatch(80, 30);
		expect(first?.rows).toEqual(Array.from({ length: 10 }, (_value, index) => `row-${index}`));
		transcript.acknowledgeFinalizedBatch(first!.id);
		expect(transcript.renderViewport(80, 30, frame)).toEqual(
			Array.from({ length: 30 }, (_value, index) => `row-${index + 10}`),
		);

		transcript.beginReplay();
		const replay = transcript.peekReplayBatch(80);
		expect(replay?.rows).toEqual(Array.from({ length: 10 }, (_value, index) => `row-${index}`));
		expect(transcript.renderViewport(80, 30, frame)).toEqual(
			Array.from({ length: 30 }, (_value, index) => `row-${index + 10}`),
		);
		transcript.acknowledgeFinalizedBatch(replay!.id);
		expect(transcript.peekReplayBatch(80)).toBeUndefined();
		expect(transcript.renderViewport(80, 30, frame)).toEqual(
			Array.from({ length: 30 }, (_value, index) => `row-${index + 10}`),
		);
	});

	it("retires the declared settled rows of a still-live block", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(["live 1", "live 2", "live 3"], false);
		block.setSettledRows(2);
		transcript.addChild(block);

		// Under zero capacity, the settled prefix is offered.
		const batch = transcript.peekFinalizedBatch(80, 0);
		expect(batch?.rows).toEqual(["live 1", "live 2"]);

		// The live viewport excludes the offered prefix.
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["live 3"]);

		transcript.acknowledgeFinalizedBatch(batch!.id);

		// After acknowledgment, the prefix remains excluded.
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["live 3"]);
	});

	it("correctly maps raw settled rows to stripped live blocks when offering history", () => {
		const transcript = new TranscriptContainer();
		// 2 leading blanks, 3 content rows, 1 trailing blank. Total 6 rows.
		const block = new Block(["", "  ", "live 1", "live 2", "live 3", ""], false);
		transcript.addChild(block);

		// 4 raw rows settled: the 2 leading blanks, "live 1", and "live 2".
		block.setSettledRows(4);

		// With zero capacity, it forces the settled prefix out into history.
		const batch = transcript.peekFinalizedBatch(80, 0);
		// The leading blanks are stripped from both the history batch and the viewport.
		// The mapped settled length is 4 - 2 = 2 rows of the stripped content.
		expect(batch?.rows).toEqual(["live 1", "live 2"]);

		// The live viewport should contain only the remaining stripped content row.
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["live 3"]);

		transcript.acknowledgeFinalizedBatch(batch!.id);

		// Increase settled raw rows to 5 (includes "live 3").
		block.setSettledRows(5);

		const batch2 = transcript.peekFinalizedBatch(80, 0);
		// Remaining settled stripped rows: 5 - 2 = 3. We already offered 2, so 1 more is offered.
		expect(batch2?.rows).toEqual(["live 3"]);

		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
	});

	it("reoffers committed history after an explicit destructive reset", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		if (first === undefined) throw new Error("expected initial batch");
		transcript.acknowledgeFinalizedBatch(first.id);

		transcript.resetStableEmission();
		// Fits again after the reset: stays live until pressure returns.
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["final"]);
		const replay = transcript.peekFinalizedBatch(80, 0);
		expect(replay?.id).toBeGreaterThan(first.id);
		expect(replay?.rows).toEqual(["final", ""]);
	});
});
