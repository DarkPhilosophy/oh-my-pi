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

	getTranscriptBlockSettledRows?(): number;

	setSettledRows(n: number): void {
		this.getTranscriptBlockSettledRows = () => n;
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
	it("keeps settled blocks live while the viewport has room", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled"], true));
		transcript.addChild(new Block(["streaming"], false));

		// Both fit: nothing retires, the settled block still renders live.
		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["settled", "", "streaming"]);
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

	it("keeps a constrained live block intact in the logical viewport", () => {
		const transcript = new TranscriptContainer();
		const rows = Array.from({ length: 8 }, (_value, index) => `row-${index}`);
		const block = new AllocationAwareBlock(rows);
		transcript.addChild(block);

		expect(transcript.renderViewport(80, 3, frame)).toEqual(rows);
		block.finalize();

		expect(transcript.peekFinalizedBatch(80, 0)?.rows).toEqual([...rows, ""]);
	});

	it("keeps every live block intact when the logical viewport exceeds physical capacity", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["first"], false));
		transcript.addChild(new Block(["second"], false));

		expect(transcript.renderViewport(80, 2, frame)).toEqual(["first", "", "second"]);
		expect(transcript.canAdmit(2)).toBe(false);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["first", "", "second"]);
	});
	it("keeps settled resume backlog visible until history accepts it", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled one"], true));
		transcript.addChild(new Block(["settled two"], true));
		transcript.addChild(new Block(["current tool"], false));

		// The welcome header can consume the first history offer, leaving the
		// settled transcript prefix live for one frame while it drains next.
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["settled one", "", "settled two", "", "current tool"]);
	});
	it("excludes empty blocks without collapsing the logical viewport (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		// Text blocks interleaved with empty (hidden tool-activity) blocks that
		// render nothing but stay live until retired.
		for (let i = 0; i < 6; i++) {
			transcript.addChild(new Block([`t${i}a`, `t${i}b`, `t${i}c`], true));
			for (let j = 0; j < 8; j++) transcript.addChild(new Block([], true));
		}
		const out = transcript.renderViewport(80, 12, frame);
		expect(out.filter(row => row.length > 0)).toHaveLength(18);
		expect(out.filter(row => row.length > 0).every(row => /\S/.test(row))).toBe(true);
	});

	it("empty blocks do not remove real text from the logical viewport (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["A1", "A2", "A3", "A4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["B1", "B2", "B3", "B4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["C1", "C2", "C3", "C4"], true));
		const out = transcript.renderViewport(80, 10, frame);
		expect(out).toEqual(["A1", "A2", "A3", "A4", "", "B1", "B2", "B3", "B4", "", "C1", "C2", "C3", "C4"]);
	});

	it("permits removing settled blocks until they are offered or committed", () => {
		const transcript = new TranscriptContainer();
		const settled = new Block(["settled snapshot"], true);
		const live = new Block(["live", "live", "live"], false);
		transcript.addChild(settled);
		transcript.addChild(live);

		// Settled but still in the mutable viewport: removable without a trace,
		// so a follow-up displaceable snapshot can retract it.
		expect(transcript.canRemoveBlock(settled)).toBe(true);

		// Offered to the terminal: mid-write, no longer removable.
		const batch = transcript.peekFinalizedBatch(80, 2);
		expect(batch?.rows).toEqual(["settled snapshot", ""]);
		expect(transcript.canRemoveBlock(settled)).toBe(false);

		// Committed: immutable history; removal must be refused outright.
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.canRemoveBlock(settled)).toBe(false);
		transcript.removeChild(settled);
		expect(transcript.blockStates()).toEqual(["committed", "active"]);
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
