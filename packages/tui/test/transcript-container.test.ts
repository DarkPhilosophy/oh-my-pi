import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TranscriptContainer, type TranscriptStableRow } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
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

function literalStableRow(row: string): TranscriptStableRow {
	return { key: row };
}

class AppendBlock extends Block {
	readonly transcriptBlockMode = "appendOnly" as const;
	#stable: readonly TranscriptStableRow[];
	#stableRender: readonly string[];

	constructor(rows: string[], stable: readonly string[], finalized = false) {
		super(rows, finalized);
		this.#stable = stable.map(literalStableRow);
		this.#stableRender = stable;
	}

	publish(rows: readonly string[]): void {
		this.#stable = rows.map(literalStableRow);
		this.#stableRender = rows;
	}

	publishStable(rows: readonly TranscriptStableRow[], rendered: readonly string[]): void {
		this.#stable = rows;
		this.#stableRender = rendered;
	}

	/** Change the block's full render without finalizing (e.g. hiding thinking). */
	revise(rows: string[]): void {
		this.finalize(rows);
	}

	resetTranscriptStableRows(): void {
		this.#stable = [];
		this.#stableRender = [];
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return this.#stable;
	}

	renderTranscriptStableRows(count: number, _width: number): readonly string[] {
		return this.#stableRender.slice(0, count);
	}
}

class ReflowingAppendBlock implements Component {
	readonly transcriptBlockMode = "appendOnly" as const;
	#finalized = false;
	readonly #stable: TranscriptStableRow = { key: "abcdefgh" };

	isTranscriptBlockFinalized(): boolean {
		return this.#finalized;
	}

	finalize(): void {
		this.#finalized = true;
	}

	getTranscriptStableRows(): readonly TranscriptStableRow[] {
		return [this.#stable];
	}

	renderTranscriptStableRows(count: number, width: number): readonly string[] {
		if (count <= 0) return [];
		const rows: string[] = [];
		for (let offset = 0; offset < 8; offset += width) rows.push("abcdefgh".slice(offset, offset + width));
		return rows;
	}

	render(width: number): readonly string[] {
		return [...this.renderTranscriptStableRows(1, width), this.#finalized ? "final" : "partial"];
	}
}

class ToolBlock extends Block {
	setToolActivityVisible(): void {}
}

class SlowBlock extends Block {
	#costMs: number;
	constructor(rows: string[], costMs: number) {
		super(rows, true);
		this.#costMs = costMs;
	}
	override render(): readonly string[] {
		const until = performance.now() + this.#costMs;
		while (performance.now() < until) {}
		return super.render();
	}
}

class CountingBlock extends Block {
	renders = 0;
	constructor(rows: string[]) {
		super(rows, true);
	}
	override render(): readonly string[] {
		this.renders++;
		return super.render();
	}
}

const finalAnswer: AssistantMessage = {
	role: "assistant",
	content: [
		{ type: "thinking", thinking: "Reasoning first" },
		{ type: "text", text: "## Implemented" },
	],
	api: "openai-codex-responses",
	provider: "openai-codex",
	model: "gpt-5.6-sol",
	stopReason: "stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 1,
};

const frame = { tick: 0, now: 0 };

describe("TranscriptContainer", () => {
	it("renders externally added children after removing another child", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["first"], false);
		const removed = new Block(["removed"], false);
		const external = new Block(["external"], false);
		transcript.addChild(first);
		transcript.addChild(removed);
		transcript.children.push(external);
		transcript.removeChild(removed);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["first", "", "external"]);
	});

	it("preserves retirement while externally reordered and replaced live children settle", () => {
		const transcript = new TranscriptContainer();
		const archived = new Block(["archived"], true);
		transcript.addChild(archived);
		const history = transcript.peekFlushBatch(80);
		if (!history) throw new Error("Expected history batch");
		transcript.acknowledgeFinalizedBatch(history.id);
		const first = new Block(["first"], false);
		const second = new Block(["second"], false);
		transcript.addChild(first);
		transcript.addChild(second);
		transcript.children.splice(1, 2, second, first);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["second", "", "first"]);
		const replacement = new Block(["replacement"], false);
		const external = [archived, second, replacement];
		transcript.children = external;
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["second", "", "replacement"]);
		external[1] = first;
		first.finalize(["first done"]);
		replacement.finalize(["replacement done"]);
		const final = transcript.peekFlushBatch(80);
		expect(final?.rows).toEqual(["first done", "", "replacement done", ""]);
		if (!final) throw new Error("Expected live retirement batch");
		transcript.acknowledgeFinalizedBatch(final.id);
		expect(transcript.peekFlushBatch(80)).toBeUndefined();
		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)?.rows).toEqual(["archived", "", "first done", "", "replacement done", ""]);
	});

	it("captures mutable by default and append-only declarations permanently", () => {
		const transcript = new TranscriptContainer();
		const mutable = new Block(["mutable"], false) as Block & {
			transcriptBlockMode?: "appendOnly";
			getTranscriptStableRows?: () => readonly TranscriptStableRow[];
		};
		transcript.addChild(mutable);
		mutable.transcriptBlockMode = "appendOnly";
		mutable.getTranscriptStableRows = () => [literalStableRow("mutable")];
		transcript.addChild(new AppendBlock(["stable", "partial"], ["stable"]));

		expect(transcript.blockModes()).toEqual(["mutable", "appendOnly"]);
	});

	it("freezes a retracting publication and keeps rendering the block", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);

		// Retraction cannot be honored (rows may already sit in scrollback):
		// the block demotes to finalize-time retirement but never fails a render.
		block.publish(["changed"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);
		expect(transcript.blockModes()).toEqual(["appendOnly"]);
	});

	it("freezes drifted stable bytes, keeps the emitted slice, and retires the remainder once", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["one", "two"]);

		const emitted = transcript.peekFinalizedBatch(80, 0)!;
		expect(emitted.rows).toEqual(["one"]);
		transcript.acknowledgeFinalizedBatch(emitted.id);

		// Published bytes drift (e.g. a mid-stream theme change): the emitted
		// slice stays retired, the live tail keeps rendering, and no further
		// mid-stream row is offered.
		block.publishStable([literalStableRow("one"), literalStableRow("two")], ["one", "changed physical row"]);
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["two"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();

		// Finalization retires exactly the un-emitted suffix.
		block.finalize(["one", "two"]);
		expect(transcript.peekFinalizedBatch(80, 0)?.rows).toEqual(["two", ""]);
	});

	it("emits only the stable current head under row pressure", () => {
		const transcript = new TranscriptContainer();
		const head = new Block(["mutable head"], false);
		const later = new AppendBlock(["later stable", "later partial"], ["later stable"]);
		transcript.addChild(head);
		transcript.addChild(later);

		expect(transcript.peekFinalizedBatch(80, 1)).toBeUndefined();

		head.finalize(["mutable head"]);
		const retired = transcript.peekFinalizedBatch(80, 1);
		expect(retired?.rows).toEqual(["mutable head", ""]);
		transcript.acknowledgeFinalizedBatch(retired!.id);

		const emitted = transcript.peekFinalizedBatch(80, 1);
		expect(emitted?.rows).toEqual(["later stable"]);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["later partial"]);
	});

	it("counts multi-row snapshot prefixes by rendered rows, not snapshot count", () => {
		// One snapshot rendering to 4 physical rows: the old min(rows, count)
		// memo returned 1 row for count=1 and the container redrew retired
		// content into the live region. The per-(width,count) memo returns
		// the real rendered length.
		const transcript = new TranscriptContainer();
		const block = new ReflowingAppendBlock();
		transcript.addChild(block);
		// Prime the container through a live-count pass at width 2: one
		// snapshot -> 4 physical rows.
		transcript.liveRowCount(2);
		transcript.liveRowCount(2);
		const viewport = transcript.renderViewport(2, 10, frame);
		expect(viewport.length).toBeGreaterThan(1);
	});

	it("retires only the un-emitted final suffix", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two", "partial"], ["one", "two"]);
		transcript.addChild(block);

		const first = transcript.peekFinalizedBatch(80, 2)!;
		expect(first.rows).toEqual(["one"]);
		transcript.acknowledgeFinalizedBatch(first.id);
		const second = transcript.peekFinalizedBatch(80, 1)!;
		expect(second.rows).toEqual(["two"]);
		transcript.acknowledgeFinalizedBatch(second.id);

		block.finalize(["one", "two", "final"]);
		const suffix = transcript.peekFinalizedBatch(80, 0)!;
		expect(suffix.rows).toEqual(["final", ""]);
	});

	it("advances a fully emitted finalized head without a physical write", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["complete"], ["complete"]);
		transcript.addChild(block);
		const emitted = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(emitted.id);

		block.finalize(["complete"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
		expect(transcript.blockStates()).toEqual(["committed"]);
		expect(transcript.render(80)).toEqual(["complete"]);
		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)?.rows).toEqual(["complete", ""]);
	});

	it("replays and retires semantic stable rows after they reflow at a new width", () => {
		const transcript = new TranscriptContainer();
		const block = new ReflowingAppendBlock();
		transcript.addChild(block);

		const emitted = transcript.peekFinalizedBatch(4, 2)!;
		expect(emitted.rows).toEqual(["abcd", "efgh"]);
		transcript.acknowledgeFinalizedBatch(emitted.id);
		expect(transcript.renderViewport(8, 1, frame)).toEqual(["partial"]);

		transcript.beginReplay();
		const replay = transcript.peekReplayBatch(8)!;
		expect(replay.rows).toEqual(["abcdefgh"]);
		transcript.acknowledgeFinalizedBatch(replay.id);

		block.finalize();
		const suffix = transcript.peekFinalizedBatch(8, 0)!;
		expect(suffix.rows).toEqual(["final", ""]);
	});

	it("drops emitted stable rows on reset so a replay honors a hidden presentation (#10177)", () => {
		const transcript = new TranscriptContainer();
		// A thinking block whose reasoning prefix streams into scrollback ahead of
		// its answer while the whole block is still the live frontier head.
		const block = new AppendBlock(["reasoning one", "reasoning two", "answer"], ["reasoning one", "reasoning two"]);
		transcript.addChild(block);

		// Under pressure the finished rows the overflow needs retire in one batch.
		const first = transcript.peekFinalizedBatch(80, 1)!;
		expect(first.rows).toEqual(["reasoning one", "reasoning two"]);
		transcript.acknowledgeFinalizedBatch(first.id);
		expect(transcript.emittedStableRows()).toEqual([2]);

		// Ctrl+T hides thinking: the block now renders only its answer and drops
		// its published reasoning snapshots. resetStableEmission forgets the
		// emitted prefix so the paired destructive replay does not resurrect the
		// captured reasoning that visibly streamed into scrollback.
		block.revise(["answer"]);
		transcript.resetStableEmission();
		expect(transcript.emittedStableRows()).toEqual([0]);

		transcript.beginReplay();
		const replay = transcript.peekReplayBatch(80);
		expect(replay).toBeUndefined();
		expect(transcript.renderViewport(80, 5, frame)).toEqual(["answer"]);
	});

	it("does not offer an empty replay for a plain-session width resize", () => {
		const transcript = new TranscriptContainer();
		transcript.renderViewport(80, 5, frame);
		transcript.beginReplay();
		expect(transcript.peekReplayBatch(60)).toBeUndefined();
		expect(transcript.renderViewport(60, 5, frame)).toEqual([]);
	});

	it("offers an acknowledged empty replay when cursor-overlay repair requests it", () => {
		const transcript = new TranscriptContainer();

		transcript.beginReplay(true);
		const replay = transcript.peekReplayBatch(80);

		expect(replay).toEqual({ id: 1, rows: [], kind: "replay" });
		transcript.acknowledgeFinalizedBatch(replay!.id);
		expect(transcript.peekReplayBatch(80)).toBeUndefined();
	});

	beforeAll(async () => {
		await initTheme(false);
	});

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

	it("stops admitting live blocks once every active block already owns a row", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["first"], false));
		transcript.addChild(new Block(["second"], false));

		// The live viewport keeps every logical row — physical clipping is the
		// frame renderer's job — so admission control is the capacity signal.
		expect(transcript.renderViewport(80, 2, frame)).toEqual(["first", "", "second"]);
		expect(transcript.canAdmit(2)).toBe(false);
		expect(transcript.canAdmit(3)).toBe(true);
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["first", "", "second"]);
	});
	it("preserves settled resume backlog without reporting it as active", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["settled one"], true));
		transcript.addChild(new Block(["settled two"], true));
		transcript.addChild(new Block(["current tool"], false));

		// The welcome header can consume the first history offer, leaving the
		// settled transcript prefix live for one frame while it drains next.
		expect(transcript.renderViewport(80, 1, frame)).toEqual(["settled one", "", "settled two", "", "current tool"]);
		expect(transcript.canAdmit(1)).toBe(false);
		expect(transcript.canAdmit(2)).toBe(true);
	});
	it("retires a resumed ledger across frames instead of one blocking batch (#12933)", () => {
		const transcript = new TranscriptContainer();
		const blocks = Array.from({ length: 6 }, (_, index) => new SlowBlock([`block ${index}`], 4));
		for (const block of blocks) transcript.addChild(block);

		const drained: string[] = [];
		let batches = 0;
		for (let batch = transcript.peekFinalizedBatch(80, 0); batch !== undefined;) {
			drained.push(...batch.rows);
			transcript.acknowledgeFinalizedBatch(batch.id);
			if (++batches > blocks.length) throw new Error("retirement did not converge");
			batch = transcript.peekFinalizedBatch(80, 0);
		}

		// The whole backlog would block the frame that first paints it, so a
		// batch stops at the render budget and the rest follows on later frames.
		expect(batches).toBeGreaterThan(1);
		// Chunking must not reorder, drop, or duplicate a single scrollback row.
		expect(drained.filter(row => row !== "")).toEqual(blocks.map((_, index) => `block ${index}`));
		expect(transcript.blockStates()).toEqual(blocks.map(() => "committed"));
	});

	it("reuses backlog measurements while preserving complete logical rows (#12933)", () => {
		const transcript = new TranscriptContainer();
		const blocks = Array.from({ length: 40 }, (_, index) => new CountingBlock([`row ${index}`]));
		for (const block of blocks) transcript.addChild(block);
		transcript.beginPaint(frame);
		try {
			expect(transcript.liveRowCount(80)).toBe(79);
			expect(transcript.renderViewport(80, 4, frame).filter(row => row !== "")).toEqual(
				blocks.map((_, index) => `row ${index}`),
			);
			expect(blocks.map(block => block.renders)).toEqual(blocks.map(() => 1));
		} finally {
			transcript.endPaint();
		}
	});

	it("preserves full block content rather than an emergency summary behind the viewport", () => {
		class HintBlock extends Block {
			renderTranscriptBlockEmergencyRow(): string {
				return "hint";
			}
		}
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["running"], false));
		transcript.addChild(new HintBlock(["hint body"], true));
		for (let index = 0; index < 5; index++) transcript.addChild(new Block([`settled ${index}`], true));

		expect(transcript.renderViewport(80, 2, frame)).toEqual([
			"running",
			"",
			"hint body",
			"",
			"settled 0",
			"",
			"settled 1",
			"",
			"settled 2",
			"",
			"settled 3",
			"",
			"settled 4",
		]);
	});

	it("does not count empty active blocks behind the viewport as hidden work", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["running"], false));
		transcript.addChild(new Block([], false));
		for (let index = 0; index < 4; index++) transcript.addChild(new Block([`settled ${index}`], true));

		expect(transcript.renderViewport(80, 2, frame)).toEqual([
			"running",
			"",
			"settled 0",
			"",
			"settled 1",
			"",
			"settled 2",
			"",
			"settled 3",
		]);
	});

	it("excludes empty blocks without losing logical text (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		// Text blocks interleaved with empty (hidden tool-activity) blocks that
		// render nothing but stay live until retired.
		for (let i = 0; i < 6; i++) {
			transcript.addChild(new Block([`t${i}a`, `t${i}b`, `t${i}c`], true));
			for (let j = 0; j < 8; j++) transcript.addChild(new Block([], true));
		}
		// Empty blocks contribute neither content nor an extra separator.
		const out = transcript.renderViewport(80, 12, frame);
		expect(out.filter(row => row !== "")).toEqual(
			Array.from({ length: 6 }, (_, i) => [`t${i}a`, `t${i}b`, `t${i}c`]).flat(),
		);
		expect(out.filter(row => row === "")).toHaveLength(5);
	});

	it("empty blocks do not reserve capacity from real text under pressure (issue 9483)", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["A1", "A2", "A3", "A4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["B1", "B2", "B3", "B4"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new Block(["C1", "C2", "C3", "C4"], true));
		// All real text remains available to the native frame; empty blocks add no padding.
		const out = transcript.renderViewport(80, 10, frame);
		expect(out).toEqual(["A1", "A2", "A3", "A4", "", "B1", "B2", "B3", "B4", "", "C1", "C2", "C3", "C4"]);
	});

	it("preserves user message text and surrounding ledger content under physical pressure (issue 13835)", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["stuck tool"], false)); // pins retirement
		for (let i = 0; i < 6; i++) transcript.addChild(new Block([`settled ${i}`], true));
		const userMsg = new UserMessageComponent("is there a reason we haven't tested against the real device yet?");
		transcript.addChild(userMsg);
		transcript.addChild(new Block(["after 1"], true));
		transcript.addChild(new Block(["after 2"], true));

		const rendered = transcript.renderViewport(80, 5, frame);
		expect(rendered[0]).toBe("stuck tool");
		expect(rendered.at(-1)).toBe("after 2");
		const userRow = rendered.find(row => row.includes("is there a reason")) ?? "";
		expect(userRow).toContain("is there a reason we haven't tested against the real device yet?");
		expect(userRow).not.toContain("\x1b]133;A");
		expect(userRow).not.toContain("\x1b]133;B");
	});

	it("retains user message text behind the physical viewport (issue 13835)", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["stuck tool"], false)); // pins retirement
		const userMsg = new UserMessageComponent("first prompt behind viewport");
		transcript.addChild(userMsg);
		for (let i = 0; i < 10; i++) transcript.addChild(new Block([`settled ${i}`], true));

		const rendered = transcript.renderViewport(80, 2, frame);
		const userRow = rendered.find(row => row.includes("first prompt behind viewport")) ?? "";
		expect(userRow).toContain("first prompt behind viewport");
		expect(userRow).not.toContain("\x1b]133;A");
		expect(rendered.at(-1)).toBe("settled 9");
	});

	it("UserMessageComponent emergency row renders first content line and omits shell integration", () => {
		const userMsg = new UserMessageComponent("first line\nsecond line");
		const row = userMsg.renderTranscriptBlockEmergencyRow(80);
		expect(row).toBeDefined();
		expect(row).toContain("first line");
		expect(row).not.toContain("second line");
		expect(row).not.toContain("\x1b]133;A");
		expect(row).not.toContain("\x1b]133;B");
	});

	it("UserMessageComponent reuses measured lines under one-row allocation without duplicate child render", () => {
		const userMsg = new UserMessageComponent("single render test");
		userMsg.setTranscriptAllocation(1);
		let superRenderCalls = 0;
		const superProto = Object.getPrototypeOf(UserMessageComponent.prototype) as {
			render: (width: number) => readonly string[];
		};
		const origSuperRender = superProto.render;
		superProto.render = function (this: unknown, width: number) {
			superRenderCalls++;
			return origSuperRender.call(this, width);
		};
		try {
			const rows = userMsg.render(80);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toContain("single render test");
			expect(superRenderCalls).toBe(1);
		} finally {
			superProto.render = origSuperRender;
		}
	});

	it("keeps a completed assistant answer visible behind an active prefix", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["stale active"], false));
		transcript.addChild(new AssistantMessageComponent(finalAnswer));
		transcript.addChild(new Block(["continued turn"], false));
		transcript.addChild(new Block(["task running"], false));

		expect(transcript.peekFinalizedBatch(80, 3)).toBeUndefined();
		const rows = transcript.renderViewport(80, 3, frame);
		expect(rows[0]).toBe("stale active");
		expect(rows.some(row => Bun.stripANSI(row).trim() === "Implemented")).toBe(true);
		expect(rows).toContain("continued turn");
		expect(rows.at(-1)).toBe("task running");
	});

	it("preserves complete assistant text before a growing tool card (issue 9718)", () => {
		const transcript = new TranscriptContainer();
		const assistant = new Block(["A1", "A2", "A3", "A4"], false);
		const tool = new ToolBlock(["T1", "T2", "T3", "T4"], false);
		transcript.addChild(assistant);
		transcript.addChild(tool);
		// Logical text stays complete; only the native frame applies physical clipping.
		const out = transcript.renderViewport(80, 5, frame);
		expect(out).toEqual(["A1", "A2", "A3", "A4", "", "T1", "T2", "T3", "T4"]);
		expect(assistant.allocations.at(-1)).toBe(Number.MAX_SAFE_INTEGER);
		expect(tool.allocations.at(-1)).toBe(Number.MAX_SAFE_INTEGER);
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

	it("removes live blocks behind a settled one without disturbing committed or settled bookkeeping", () => {
		const transcript = new TranscriptContainer();
		const committedA = new Block(["committed a"], true);
		const committedB = new Block(["committed b"], true);
		transcript.addChild(committedA);
		transcript.addChild(committedB);
		const commit = transcript.peekFinalizedBatch(80, 0);
		expect(commit?.rows).toEqual(["committed a", "", "committed b", ""]);
		transcript.acknowledgeFinalizedBatch(commit!.id);

		const settled = new Block(["settled"], true);
		const live = [1, 2, 3, 4, 5].map(n => new Block([`live ${n}`], false));
		transcript.addChild(settled);
		for (const block of live) transcript.addChild(block);
		// Room for every live row: the finalized block settles and nothing is offered.
		expect(transcript.peekFinalizedBatch(80, 20)).toBeUndefined();
		expect(transcript.blockStates()).toEqual([
			"committed",
			"committed",
			"settled",
			"active",
			"active",
			"active",
			"active",
			"active",
		]);

		transcript.removeChild(live[0]!);
		transcript.removeChild(live[4]!);

		expect(transcript.blockStates()).toEqual(["committed", "committed", "settled", "active", "active", "active"]);
		const expected = [committedA, committedB, settled, live[1]!, live[2]!, live[3]!];
		expect(transcript.children).toHaveLength(expected.length);
		expected.forEach((component, index) => expect(transcript.children[index]).toBe(component));

		// Pressure retires the settled block next; committed rows are never offered again.
		const retire = transcript.peekFinalizedBatch(80, 5);
		expect(retire?.rows).toEqual(["settled", ""]);
	});

	it("refuses to remove an append-only block once its stable rows are offered or emitted", () => {
		const transcript = new TranscriptContainer();
		const block = new AppendBlock(["one", "two"], ["one"]);
		transcript.addChild(block);

		// Offered: the stable row is mid-write to native scrollback.
		const append = transcript.peekFinalizedBatch(80, 0)!;
		expect(append.rows).toEqual(["one"]);
		transcript.removeChild(block);
		expect(transcript.children).toHaveLength(1);
		expect(transcript.children[0]).toBe(block);
		expect(transcript.blockStates()).toEqual(["active"]);

		// Emitted: the row is in scrollback, so the block can no longer be retracted.
		transcript.acknowledgeFinalizedBatch(append.id);
		expect(transcript.emittedStableRows()).toEqual([1]);
		transcript.removeChild(block);
		expect(transcript.children).toHaveLength(1);
		expect(transcript.children[0]).toBe(block);
		expect(transcript.blockStates()).toEqual(["active"]);
	});

	it("replays committed history without rewinding lifecycle state", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["final"], true));
		const first = transcript.peekFinalizedBatch(80, 0);
		if (first === undefined) throw new Error("expected initial batch");
		transcript.acknowledgeFinalizedBatch(first.id);
		expect(transcript.blockStates()).toEqual(["committed"]);

		transcript.beginReplay();
		expect(transcript.renderViewport(80, 10, frame)).toEqual([]);
		const replay = transcript.peekFinalizedBatch(80, 10);
		expect(replay?.id).toBeGreaterThan(first.id);
		expect(replay?.rows).toEqual(["final", ""]);
		transcript.acknowledgeFinalizedBatch(replay!.id);
		expect(transcript.blockStates()).toEqual(["committed"]);
		expect(transcript.peekFinalizedBatch(80, 0)).toBeUndefined();
	});

	it("flushes a finalized prefix without viewport pressure", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["fits"], true));

		expect(transcript.peekFinalizedBatch(80, 10)).toBeUndefined();
		expect(transcript.peekFlushBatch(80)?.rows).toEqual(["fits", ""]);
	});

	it("keeps the live viewport while an independent replay is offered", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["committed"], true));
		const committed = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["active"], false));

		transcript.beginReplay();
		expect(transcript.peekFinalizedBatch(80, 10)?.rows).toEqual(["committed", ""]);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["active"]);
	});
	it("renders exactly the trailing semantic rows without walking the full ledger", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["a1", "a2"], true));
		transcript.addChild(new Block([], true));
		transcript.addChild(new AppendBlock(["b1", "b2"], ["b1"], true));
		transcript.addChild(new Block(["c1"], false));

		const full = transcript.render(80);
		for (const cap of [1, 3, 4, full.length, full.length + 5]) {
			expect(transcript.renderTail(80, cap)).toEqual(full.slice(-Math.min(cap, full.length)));
		}
		expect(transcript.renderTail(80, 0)).toEqual([]);
	});

	it("cancels a pending replay so shutdown flush emits only un-retired rows", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new Block(["committed"], true));
		const committed = transcript.peekFinalizedBatch(80, 0)!;
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["tail"], true));

		transcript.beginReplay();
		transcript.cancelReplay();
		expect(transcript.peekFlushBatch(80)?.rows).toEqual(["tail", ""]);
	});

	it("retains off-screen live context across insertion removal", () => {
		const transcript = new TranscriptContainer();
		const context = Array.from({ length: 8 }, (_, index) => `context-${index}`);
		transcript.addChild(new Block(context, true));
		const waiting = new Block(["waiting-one", "waiting-two"], false);
		const initial = transcript.renderLiveViewport(80, 5, frame);
		transcript.addChild(waiting);
		const inserted = transcript.renderLiveViewport(80, 5, frame);
		expect(inserted.rows).toEqual([...context, "", "waiting-one", "waiting-two"]);
		transcript.removeChild(waiting);
		const removed = transcript.renderLiveViewport(80, 5, frame);
		expect(removed.rows).toEqual(initial.rows);
		expect(transcript.peekFinalizedBatch(80, removed.capacity)).toBeUndefined();
		expect(transcript.liveViewport.rows.slice(0, 3)).toEqual(context.slice(0, 3));
	});

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
	it("does not re-emit borrowed rows that still render identically at commit", () => {
		const transcript = new TranscriptContainer();
		const card = new Block(["one", "two", "three", "four"], false);
		transcript.addChild(card);
		transcript.renderLiveViewport(80, 10, frame);
		// The top two rows scrolled into native scrollback while the card ran.
		transcript.setBorrowedViewportRows(2);
		card.finalize(["one", "two", "three", "four"]);
		const history = transcript.peekFinalizedBatch(80, 0);
		// Only the un-borrowed tail may be committed; "one"/"two" are already history.
		expect(history?.rows).toEqual(["three", "four", ""]);
		transcript.acknowledgeFinalizedBatch(history!.id);
		// A later replay owns the whole committed block again, not a sliced copy.
		transcript.beginReplay();
		expect(transcript.peekReplayBatch(80)?.rows).toEqual(["one", "two", "three", "four", ""]);
	});
	it("still retires a block whose borrow reached its trailing separator", () => {
		const transcript = new TranscriptContainer();
		const finalized = new Block(["one", "two"], false) as Block & { commitToHistoryOnFinalize?: boolean };
		finalized.commitToHistoryOnFinalize = true;
		const live = new Block(["later"], false);
		transcript.addChild(finalized);
		transcript.addChild(live);
		transcript.renderLiveViewport(80, 10, frame);
		// The terminal borrowed the block and the blank row separating it from
		// the next block — the separator belongs to no card's render output.
		transcript.setBorrowedViewportRows(3);
		finalized.finalize(["one", "two"]);
		// No pressure: retirement must come from the finalize-commit path, which
		// a separator-length borrow used to pin forever.
		const batch = transcript.peekFinalizedBatch(80, 1000);
		expect(batch).toBeDefined();
		expect(batch?.rows).toEqual([]);
		transcript.acknowledgeFinalizedBatch(batch!.id);
		expect(transcript.isBlockUncommitted(finalized)).toBe(false);
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["later"]);
	});
	it("retains borrowed blocks while allowing uncommitted blocks to be removed", () => {
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

	it("offers an acknowledged empty replay when explicitly requested for popup repair", () => {
		const transcript = new TranscriptContainer();
		transcript.beginReplay(true);
		const replay = transcript.peekReplayBatch(80);
		expect(replay).toEqual({ id: 1, rows: [], kind: "replay" });
		transcript.acknowledgeFinalizedBatch(replay!.id);
		expect(transcript.peekReplayBatch(80)).toBeUndefined();
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

describe("TranscriptContainer viewport click spans", () => {
	it("maps uncapped viewport rows to their blocks, skipping separators", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["a1", "a2"], false);
		const second = new Block(["b1"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["a1", "a2", "", "b1"]);
		expect(transcript.getLastViewportSpans()).toEqual([
			{ component: first, start: 0, end: 2 },
			{ component: second, start: 3, end: 4 },
		]);
	});

	it("clears spans when the tail is empty or cleared", () => {
		const transcript = new TranscriptContainer();
		const block = new Block(["a1"], false);
		transcript.addChild(block);
		transcript.renderViewport(80, 10, frame);
		expect(transcript.getLastViewportSpans()).toHaveLength(1);

		transcript.removeChild(block);
		expect(transcript.renderViewport(80, 0, frame)).toEqual([]);
		expect(transcript.getLastViewportSpans()).toEqual([]);

		transcript.addChild(block);
		transcript.renderViewport(80, 10, frame);
		transcript.clear();
		expect(transcript.getLastViewportSpans()).toEqual([]);
	});

	it("maps complete logical rows even beyond physical viewport height", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["a1", "a2", "a3", "a4"], false);
		const second = new Block(["b1", "b2", "b3", "b4"], false);
		transcript.addChild(first);
		transcript.addChild(second);

		expect(transcript.renderViewport(80, 5, frame)).toEqual(["a1", "a2", "a3", "a4", "", "b1", "b2", "b3", "b4"]);
		expect(transcript.getLastViewportSpans()).toEqual([
			{ component: first, start: 0, end: 4 },
			{ component: second, start: 5, end: 9 },
		]);
	});
});

describe("TranscriptContainer insertChildAt", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders a tail insertion without scanning committed history", () => {
		const transcript = new TranscriptContainer();
		const history = Array.from({ length: 64 }, (_, index) => new Block([`history ${index}`], true));
		for (const block of history) transcript.addChild(block);
		const committed = transcript.peekFlushBatch(80);
		if (!committed) throw new Error("Expected history batch");
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["anchor"], false));
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["anchor"]);

		let historyReads = 0;
		for (const [index, block] of history.entries()) {
			Object.defineProperty(transcript.children, index, {
				get: () => {
					historyReads++;
					return block;
				},
				configurable: true,
			});
		}

		transcript.insertChildAt(new Block(["inserted"], false), transcript.children.length);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["anchor", "", "inserted"]);
		expect(historyReads).toBe(0);
	});

	it("renders a middle insertion without scanning committed history", () => {
		const transcript = new TranscriptContainer();
		const history = Array.from({ length: 64 }, (_, index) => new Block([`history ${index}`], true));
		for (const block of history) transcript.addChild(block);
		const committed = transcript.peekFlushBatch(80);
		if (!committed) throw new Error("Expected history batch");
		transcript.acknowledgeFinalizedBatch(committed.id);
		transcript.addChild(new Block(["anchor"], false));
		transcript.addChild(new Block(["tail"], false));
		expect(transcript.renderViewport(80, 10, frame)).toEqual(["anchor", "", "tail"]);

		let historyReads = 0;
		for (const [index, block] of history.entries()) {
			Object.defineProperty(transcript.children, index, {
				get: () => {
					historyReads++;
					return block;
				},
				configurable: true,
			});
		}

		transcript.insertChildAt(new Block(["inserted"], false), transcript.children.length - 1);

		expect(transcript.renderViewport(80, 10, frame)).toEqual(["anchor", "", "inserted", "", "tail"]);
		expect(historyReads).toBe(0);
	});

	it("keeps inserted blocks ordered and removable across repeated inserts", () => {
		const transcript = new TranscriptContainer();
		const first = new Block(["first"], false);
		const last = new Block(["last"], false);
		transcript.addChild(first);
		transcript.addChild(last);

		const insertedA = new Block(["inserted-a"], false);
		const insertedB = new Block(["inserted-b"], false);
		transcript.insertChildAt(insertedA, 1);
		transcript.insertChildAt(insertedB, 1);

		expect(transcript.children).toEqual([first, insertedB, insertedA, last]);
		expect(transcript.canRemoveBlock(insertedA)).toBe(true);
		expect(transcript.canRemoveBlock(insertedB)).toBe(true);
	});
});
