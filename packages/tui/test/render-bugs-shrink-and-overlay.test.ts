import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();

// Repro suite for four user-reported rendering defects (screenshots 2026-09-29
// 11-19, 2026-09-29 10-56, 2026-10-01 06-16, 2026-09-30 05-51). Every oracle is
// the terminal tape (scrollback + viewport), never `component.render()`: a card
// can render correctly while the terminal already borrowed its stale rows.

const ROWS = 30;
const COLUMNS = 100;
const PREFIX = "Settled transcript row ";

class CountingTerminal extends VirtualTerminal {
	writes = "";
	override write(data: string): void {
		this.writes += data;
		super.write(data);
	}
}

function strip(rows: readonly string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

/** Runs of blank rows BETWEEN non-blank rows that are at least `minRun` long. The transcript separates blocks with one blank row, so only a run of 3+ is the black band between history and the live frame. */
/** Transcript rows present anywhere in the tape (scrollback plus screen). */
function transcriptRowCount(rows: readonly string[]): number {
	return rows.filter(row => row.startsWith(PREFIX)).length;
}

function bracketedBlankRuns(rows: readonly string[], minRun = 3): number {
	let runs = 0;
	for (let index = 0; index < rows.length; index++) {
		if (rows[index] !== "") continue;
		let end = index;
		while (rows[end] === "") end++;
		if (end - index >= minRun && index > 0 && end < rows.length) runs++;
		index = end;
	}
	return runs;
}

interface Harness {
	terminal: CountingTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	transcript: TranscriptContainer;
	/** Slot mounted under the transcript like `editorContainer` (ask dialog / selector / editor). */
	slot: Container;
	editor: Text;
}

function makeHarness(historyRows = 60, rows = ROWS): Harness {
	const terminal = new CountingTerminal(COLUMNS, rows);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	for (let i = 0; i < historyRows; i++) {
		const row = i;
		transcript.addChild({ render: () => [`${PREFIX}${row}`] });
	}
	const editor = new Text("EDITOR", 0, 0);
	const slot = new Container();
	slot.addChild(editor);
	composer.setRuntimeChildren([transcript, slot], { transient: [slot] });
	composer.start({ playWelcomeIntro: false });
	return { terminal, scheduler, composer, transcript, slot, editor };
}

class FixedRows implements Component {
	rows: string[];
	constructor(rows: readonly string[]) {
		this.rows = [...rows];
	}
	render(): readonly string[] {
		return this.rows;
	}
}

/** Tape = the whole scroll buffer: native scrollback followed by the active grid. `getScrollBuffer()` already includes the viewport, so concatenating `getViewport()` would count visible rows twice. */
function tape(terminal: VirtualTerminal): string[] {
	return strip(terminal.getScrollBuffer());
}

function transcriptIndices(rows: readonly string[]): number[] {
	return rows.filter(row => row.startsWith(PREFIX)).map(row => Number(row.slice(PREFIX.length)));
}

const cards: ToolExecutionComponent[] = [];

/** Indices in [0, count) that never reached the tape (scrollback + viewport). Order-free, snapshot-free. */
function missingTranscriptRows(rows: readonly string[], count: number): number[] {
	const seen = new Set(transcriptIndices(rows));
	return Array.from({ length: count }, (_, i) => i).filter(i => !seen.has(i));
}

/** Indices that appear more than once on the tape (a stale copy was committed next to the live one). */
function duplicatedTranscriptRows(rows: readonly string[]): number[] {
	const counts = new Map<number, number>();
	for (const index of transcriptIndices(rows)) counts.set(index, (counts.get(index) ?? 0) + 1);
	return [...counts].filter(([, n]) => n > 1).map(([index]) => index);
}

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	for (const card of cards) card.stopAnimation();
	cards.length = 0;
});

describe("bug 1: slot shrink (ask answered) must return chat and editor to the bottom without jumping", () => {
	it.each([30, 50, 70])("keeps a real completed Ask contiguous while Eval is partial at %s rows", async rows => {
		const h = makeHarness(0, rows);
		const ask = new ToolExecutionComponent(
			"ask",
			{ questions: [{ id: "q", question: "ASK_REAL_QUESTION", options: [{ label: "Choice" }] }] },
			{},
			undefined,
			h.composer.ui,
		);
		const live = new ToolExecutionComponent(
			"eval",
			{ language: "js", title: "LIVE_REAL_EVAL", code: "display(1)" },
			{},
			undefined,
			h.composer.ui,
		);
		cards.push(ask, live);
		try {
			await h.scheduler.settle(h.terminal);
			h.transcript.addChild(ask);
			ask.updateResult(
				{
					content: [{ type: "text", text: "Choice" }],
					details: {
						results: [
							{ id: "q", question: "ASK_REAL_QUESTION", options: ["Choice"], selectedOptions: ["Choice"] },
						],
					},
				},
				false,
			);
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			h.transcript.addChild(live);
			live.setArgsComplete();
			live.setExecutionStarted();
			for (let step = 1; step <= 4; step++) {
				live.updateResult({ content: [{ type: "text", text: "LIVE_REAL_OUTPUT_" + step }] }, true);
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
				const all = tape(h.terminal);
				expect(bracketedBlankRuns(all)).toBe(0);
				expect(all.filter(row => row.includes("ASK_REAL_QUESTION"))).toHaveLength(1);
				expect(all.filter(row => row.includes("LIVE_REAL_OUTPUT_" + step))).toHaveLength(1);
			}
			live.updateResult({ content: [{ type: "text", text: "LIVE_REAL_FINAL" }] }, false);
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			expect(bracketedBlankRuns(tape(h.terminal))).toBe(0);
			expect(tape(h.terminal).filter(row => row.includes("LIVE_REAL_FINAL"))).toHaveLength(1);
		} finally {
			h.composer.stop();
		}
	});

	it.each([30, 50, 70])(
		"keeps completed Ask adjacent to a live suffix across transient result changes at %s rows",
		async rows => {
			const h = makeHarness(0, rows);
			const frames = async (target: Harness, count: number) => {
				for (let index = 0; index < count; index++) {
					target.composer.ui.requestRender();
					await target.scheduler.settle(target.terminal);
				}
			};
			let transient = true;
			let suffix = ["PENDING_RECEIPT", "MESSAGE_BODY"];
			const pending: Component & { isTranscriptBlockTransient(): boolean; isTranscriptBlockFinalized(): boolean } = {
				render: () => suffix,
				isTranscriptBlockTransient: () => transient,
				isTranscriptBlockFinalized: () => !transient,
			};
			const ask: Component & { commitToHistoryOnFinalize: boolean; isTranscriptBlockFinalized(): boolean } = {
				render: () => ["ASK_TOP", "ASK_QUESTION", "ASK_CHOICE", "ASK_BOTTOM"],
				commitToHistoryOnFinalize: true,
				isTranscriptBlockFinalized: () => true,
			};
			try {
				await h.scheduler.settle(h.terminal);
				h.transcript.addChild(ask);
				await frames(h, 3);
				h.transcript.addChild(pending);
				for (let frame = 0; frame < 3; frame++) {
					await frames(h, 1);
					expect(bracketedBlankRuns(tape(h.terminal))).toBe(0);
					expect(tape(h.terminal).filter(row => row === "ASK_TOP")).toHaveLength(1);
				}
				transient = false;
				suffix = ["INJECTED_RECEIPT", "MESSAGE_BODY"];
				await frames(h, 3);
				expect(bracketedBlankRuns(tape(h.terminal))).toBe(0);
				expect(tape(h.terminal).filter(row => row === "ASK_TOP")).toHaveLength(1);
			} finally {
				h.composer.stop();
			}
		},
	);

	interface Pos {
		editorRow: number;
		lastTranscriptRow: number;
	}

	function position(h: Harness): Pos {
		const view = strip(h.terminal.getViewport());
		return {
			editorRow: view.findIndex(row => row.includes("EDITOR")),
			lastTranscriptRow:
				view
					.map((row, i) => (row.startsWith(PREFIX) ? i : -1))
					.filter(i => i >= 0)
					.at(-1) ?? -1,
		};
	}

	/** Render frames one at a time and record the position after each, so motion can be audited frame by frame. */
	async function framePositions(h: Harness, frames = 4): Promise<Pos[]> {
		const out: Pos[] = [];
		for (let i = 0; i < frames; i++) {
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			out.push(position(h));
		}
		return out;
	}

	it("control: an editor that wraps to 2 rows and back moves once and stays put (the behavior to preserve)", async () => {
		const h = makeHarness();
		try {
			await h.scheduler.settle(h.terminal);
			const start = position(h);
			const two = new Container();
			two.addChild(h.editor);
			two.addChild(new Text("wrapped second row", 0, 0));
			h.slot.clear();
			h.slot.addChild(two);
			const grown = await framePositions(h);
			h.slot.clear();
			h.slot.addChild(h.editor);
			const shrunk = await framePositions(h);

			// Every frame after the first settles on the same position: no oscillation.
			expect(new Set(grown.slice(1).map(p => p.editorRow)).size).toBe(1);
			expect(new Set(shrunk.map(p => p.editorRow)).size).toBe(1);
			// The chat never ends further from the bottom than the editor's own growth cost.
			expect(start.editorRow - shrunk.at(-1)!.editorRow).toBeLessThanOrEqual(1);
		} finally {
			h.composer.stop();
		}
	});

	// History length decides whether growing the slot displaces transcript rows
	// (12 rows fit above a small dialog; 30 and 60 do not). Two contracts follow,
	// kept in separate tests so each can fail on its own:
	//  1. grow:   rows a dialog displaces are committed to scrollback right away, so
	//             none is hidden under the dialog and replayed after it closes.
	//  2. return: when the dialog goes away nothing is lost, duplicated, or turned into
	//             a blank band, and the editor settles in a single move.
	// Distinct branches of the same contract, one row each:
	//  fits:      the dialog fits above the existing rows, so it displaces nothing;
	//  displaces: the dialog pushes transcript rows out of the viewport.
	const branches = [
		{ name: "fits above the history", history: 12, askRows: 6 },
		{ name: "displaces rows", history: 30, askRows: 14 },
	] as const;
	for (const { name, history, askRows } of branches) {
		it(`grow, ${name}: a ${askRows}-row ask dialog hides no transcript row under it`, async () => {
			const h = makeHarness(history);
			try {
				await h.scheduler.settle(h.terminal);
				const before = transcriptRowCount(tape(h.terminal));

				h.slot.clear();
				h.slot.addChild(new FixedRows(Array.from({ length: askRows }, (_, i) => `ask dialog row ${i}`)));
				await framePositions(h);

				// A row hidden under the dialog is in neither the screen nor scrollback until the
				// dialog closes, so the transcript rows the tape holds must not shrink while it is open.
				const grown = tape(h.terminal);
				expect(transcriptRowCount(grown)).toBeGreaterThanOrEqual(before);
				expect(duplicatedTranscriptRows(grown)).toEqual([]);
			} finally {
				h.composer.stop();
			}
		});

		it(`return, ${name}: answering a ${askRows}-row ask dialog loses, duplicates and blanks nothing`, async () => {
			const h = makeHarness(history);
			try {
				await h.scheduler.settle(h.terminal);
				const before = transcriptRowCount(tape(h.terminal));

				h.slot.clear();
				h.slot.addChild(new FixedRows(Array.from({ length: askRows }, (_, i) => `ask dialog row ${i}`)));
				await framePositions(h);
				const open = transcriptRowCount(tape(h.terminal));
				h.slot.clear();
				h.slot.addChild(h.editor);
				const after = await framePositions(h);

				// The return is a single move, not a hop through intermediate positions.
				expect(new Set(after.slice(1).map(p => p.editorRow)).size).toBe(1);
				// Nothing that was readable while the dialog was open disappears when it closes.
				const closed = tape(h.terminal);
				expect(transcriptRowCount(closed)).toBeGreaterThanOrEqual(Math.max(before, open));
				expect(missingTranscriptRows(closed, history)).toEqual([]);
				expect(duplicatedTranscriptRows(closed)).toEqual([]);
				// A band already committed to scrollback is permanent.
				expect(bracketedBlankRuns(closed)).toBe(0);
			} finally {
				h.composer.stop();
			}
		});
	}

	// Safety net for the grow contract. While transient chrome is up, the transcript rows it covers
	// are in neither the viewport nor scrollback by design, so completeness is only asserted once the
	// chrome is gone. A slot as tall as, or taller than, the viewport cannot be "covered only" (the
	// frame cannot fit), so the transcript must keep retiring and nothing may be lost for good.
	for (const history of [3, 12, 30, 60]) {
		for (const askRows of [ROWS - 1, ROWS, ROWS + 12]) {
			it(`history=${history}: a ${askRows}-row slot (viewport is ${ROWS}) loses no transcript row once it closes`, async () => {
				const h = makeHarness(history);
				try {
					await h.scheduler.settle(h.terminal);
					// Discriminator: if rows are already missing here the harness, not the fix, is wrong.
					expect(missingTranscriptRows(tape(h.terminal), history)).toEqual([]);

					h.slot.clear();
					h.slot.addChild(new FixedRows(Array.from({ length: askRows }, (_, i) => `ask dialog row ${i}`)));
					await framePositions(h);
					h.slot.clear();
					h.slot.addChild(h.editor);
					await framePositions(h);

					expect(missingTranscriptRows(tape(h.terminal), history)).toEqual([]);
					expect(duplicatedTranscriptRows(tape(h.terminal))).toEqual([]);
				} finally {
					h.composer.stop();
				}
			});
		}
	}

	// The hazard of covering chrome rows without committing them needs two things at once: a live
	// region that really overflows (a streaming tool card) AND chrome taller than that overflow.
	// An ask that arrives while a tool is running is exactly that. Nothing may be lost once it closes.
	for (const askRows of [6, 14, ROWS + 12]) {
		it(`a ${askRows}-row slot opened and closed while a bash card streams loses no transcript row`, async () => {
			const h = makeHarness(40);
			try {
				await h.scheduler.settle(h.terminal);
				const card = new ToolExecutionComponent(
					"bash",
					{ command: "for i in $(seq 1 80); do echo line-$i; sleep 1; done" },
					{},
					undefined,
					h.composer.ui as unknown as TUI,
				);
				cards.push(card);
				h.transcript.addChild(card);
				card.setArgsComplete();
				card.setExecutionStarted();
				const lines: string[] = [];
				const push = async (count: number) => {
					for (let i = 0; i < count; i++) {
						lines.push(`line-${lines.length + 1}`);
						card.updateResult({ content: [{ type: "text", text: lines.join("\n") }] }, true);
						h.composer.ui.requestRender();
						await h.scheduler.settle(h.terminal);
					}
				};
				await push(30);
				h.slot.clear();
				h.slot.addChild(new FixedRows(Array.from({ length: askRows }, (_, i) => `ask dialog row ${i}`)));
				await push(10);
				h.slot.clear();
				h.slot.addChild(h.editor);
				await push(5);
				for (let i = 0; i < 3; i++) {
					h.composer.ui.requestRender();
					await h.scheduler.settle(h.terminal);
				}

				expect(missingTranscriptRows(tape(h.terminal), 40)).toEqual([]);
				expect(duplicatedTranscriptRows(tape(h.terminal))).toEqual([]);
			} finally {
				h.composer.stop();
			}
		});
	}

	it("does not wipe scrollback (ESC[3J) when the answered dialog is replaced", async () => {
		const h = makeHarness();
		try {
			await h.scheduler.settle(h.terminal);
			const before = h.terminal.writes.split("\x1b[3J").length - 1;

			h.slot.clear();
			h.slot.addChild(new FixedRows(Array.from({ length: 14 }, (_, i) => `ask dialog row ${i}`)));
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			h.slot.clear();
			h.slot.addChild(h.editor);
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);

			expect(h.terminal.writes.split("\x1b[3J").length - 1 - before).toBe(0);
		} finally {
			h.composer.stop();
		}
	});
});

describe("bug 2: finalized output of a running bash call must reach history without waiting for the tool", () => {
	function bashArgs() {
		return { command: "for i in $(seq 1 80); do echo line-$i; sleep 1; done" };
	}

	async function streamBash(h: Harness, total: number): Promise<ToolExecutionComponent> {
		const card = new ToolExecutionComponent("bash", bashArgs(), {}, undefined, h.composer.ui as unknown as TUI);
		cards.push(card);
		h.transcript.addChild(card);
		card.setArgsComplete();
		card.setExecutionStarted();
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const lines: string[] = [];
		for (let i = 1; i <= total; i++) {
			lines.push(`line-${i}`);
			card.updateResult({ content: [{ type: "text", text: lines.join("\n") }] }, true);
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		return card;
	}

	// Phase 1: the COMMAND half of a bash/eval card is final as soon as its arguments are complete
	// and execution has started; only the output half keeps changing. The finalized half may go to
	// native history while the call runs. This does not touch the output window at all.
	//
	// Two oracles, because a card that still fits the screen keeps its committed rows visible:
	//  - the commit itself: the batch the transcript offered (and the terminal accepted) holds the command;
	//  - pure scrollback: once the card is taller than the screen, the command is there, exactly once.
	async function runningCard(h: Harness, tool: "bash" | "eval", outputLines: number) {
		const args =
			tool === "bash"
				? { command: "echo COMMAND_MARKER_LINE" }
				: { language: "js", title: "t", code: "const COMMAND_MARKER_LINE = 1;" };
		const card = new ToolExecutionComponent(tool, args, {}, undefined, h.composer.ui as unknown as TUI);
		cards.push(card);
		h.transcript.addChild(card);
		card.setArgsComplete();
		card.setExecutionStarted();
		const lines: string[] = [];
		for (let i = 1; i <= outputLines; i++) {
			lines.push(`out-${i}`);
			card.updateResult(partialResult(tool, lines), true);
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		return card;
	}

	/** A running call's result as the tool really emits it: eval carries its cell in `details.cells`. */
	function partialResult(tool: "bash" | "eval", lines: readonly string[], status: "running" | "complete" = "running") {
		const text = lines.join("\n");
		if (tool === "bash") return { content: [{ type: "text", text }] };
		return {
			content: [{ type: "text", text }],
			details: {
				cells: [
					{
						index: 0,
						language: "js",
						title: "t",
						code: "const COMMAND_MARKER_LINE = 1;",
						status,
						output: text,
						durationMs: status === "running" ? undefined : 1,
					},
				],
			},
		};
	}

	it.each([
		{ rows: 12, expanded: true },
		{ rows: 30, expanded: true },
		{ rows: 12, expanded: false },
		{ rows: 30, expanded: false },
	])(
		"keeps output live after a long Bash command enters history at $rows rows (expanded=$expanded)",
		async ({ rows, expanded }) => {
			const h = makeHarness(40, rows);
			const command = Array.from(
				{ length: 80 },
				(_, row) =>
					"echo COMMAND_STAGE_" + String(row).padStart(3, "0") + " alpha beta gamma delta epsilon zeta eta theta",
			).join("\n");
			const card = new ToolExecutionComponent("bash", { command, timeout: 900 }, {}, undefined, h.composer.ui);
			cards.push(card);
			try {
				await h.scheduler.settle(h.terminal);
				h.transcript.addChild(card);
				card.setExpanded(expanded);
				card.setArgsComplete();
				card.setExecutionStarted();
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
				expect(h.transcript.emittedStableRows().at(-1)).toBeGreaterThan(0);
				expect(strip(h.terminal.getViewport()).join("\n")).toMatch(/Output.*Running/);
				for (let step = 0; step < 3; step++) {
					card.updateResult({ content: [{ type: "text", text: "LIVE_STAGE_OUTPUT_" + step }] }, true);
					h.composer.ui.requestRender();
					await h.scheduler.settle(h.terminal);
					const history = strip(h.terminal.getScrollBuffer().slice(0, -h.terminal.rows)).join("\n");
					const view = strip(h.terminal.getViewport()).join("\n");
					if (expanded) expect(history).toContain("COMMAND_STAGE_000");
					expect(h.transcript.emittedStableRows().at(-1)).toBeGreaterThan(0);
					expect(card.isTranscriptBlockFinalized()).toBeFalse();
					expect(view).toContain("LIVE_STAGE_OUTPUT_" + step);
					expect(view).toMatch(/Output.*Running/);
				}
				card.updateResult(
					{
						content: [{ type: "text", text: "LIVE_STAGE_FINAL" }],
						isError: rows === 30,
						details: { exitCode: rows === 30 ? 1 : 0 },
					},
					false,
				);
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
				const all = tape(h.terminal).join("\n");
				expect(all.match(/COMMAND_STAGE_000/g)).toHaveLength(1);
				expect(all.match(/LIVE_STAGE_FINAL/g)).toHaveLength(1);
				if (expanded)
					expect(Array.from(all.matchAll(/COMMAND_STAGE_\d{3}/g), match => match[0])).toEqual(
						Array.from({ length: 80 }, (_, row) => `COMMAND_STAGE_${String(row).padStart(3, "0")}`),
					);
				expect(missingTranscriptRows(tape(h.terminal), 40)).toEqual([]);
			} finally {
				h.composer.stop();
			}
		},
	);

	for (const tool of ["bash", "eval"] as const) {
		it(`${tool}: the finalized command is committed to history while its output still streams`, async () => {
			const h = makeHarness(40);
			try {
				const offered: string[][] = [];
				const peek = h.transcript.peekFinalizedBatch.bind(h.transcript);
				h.transcript.peekFinalizedBatch = (width: number, capacity: number) => {
					const batch = peek(width, capacity);
					if (batch) offered.push(batch.rows.map(row => Bun.stripANSI(row)));
					return batch;
				};
				await h.scheduler.settle(h.terminal);
				await runningCard(h, tool, 20);
				expect(offered.flat().some(row => row.includes("COMMAND_MARKER_LINE"))).toBe(true);
				expect(offered.flat().filter(row => row.includes("COMMAND_MARKER_LINE")).length).toBe(1);
				// ...and the card still shows its live stage on a normal screen.
				expect(tape(h.terminal).some(row => /Output.*Running/.test(row))).toBe(true);
			} finally {
				h.composer.stop();
			}
		});

		it(`${tool}: finishing after the early commit duplicates nothing and leaves no blank band`, async () => {
			const h = makeHarness(40, 12);
			try {
				await h.scheduler.settle(h.terminal);
				const card = await runningCard(h, tool, 30);
				const finalLines = Array.from({ length: 30 }, (_, i) => `out-${i + 1}`);
				card.updateResult(partialResult(tool, finalLines, "complete"), false);
				for (let i = 0; i < 6; i++) {
					h.composer.ui.requestRender();
					await h.scheduler.settle(h.terminal);
				}
				const all = tape(h.terminal);
				expect(all.filter(row => row.includes("COMMAND_MARKER_LINE")).length).toBe(1);
				expect(missingTranscriptRows(all, 40)).toEqual([]);
				expect(duplicatedTranscriptRows(all)).toEqual([]);
				expect(bracketedBlankRuns(all)).toBe(0);
			} finally {
				h.composer.stop();
			}
		});

		it(`${tool}: the committed command appears once on the tape, after the history and before its output`, async () => {
			const h = makeHarness(40, 12);
			try {
				await h.scheduler.settle(h.terminal);
				await runningCard(h, tool, 40);
				const all = tape(h.terminal);
				const marker = all.findIndex(row => row.includes("COMMAND_MARKER_LINE"));
				expect(all.filter(row => row.includes("COMMAND_MARKER_LINE")).length).toBe(1);
				// ordered: the last history row, then the command, then streamed output - never the reverse.
				expect(all.findLastIndex(row => row === `${PREFIX}39`)).toBeLessThan(marker);
				expect(all.findIndex(row => row.includes("out-40"))).toBeGreaterThan(marker);
				expect(missingTranscriptRows(all, 40)).toEqual([]);
				expect(duplicatedTranscriptRows(all)).toEqual([]);
				// The early commit must not cost the frame its other rows: the elision marker that says output
				// is hidden survives in the live remainder (a frame that lost it still has the command once).
				// The Output separator needs room: a 12-row screen has none, with or without the early commit.
				expect(all.some(row => row.includes("earlier line"))).toBe(true);
			} finally {
				h.composer.stop();
			}
		});
	}

	it("output rows that scrolled out of the live preview are readable on the tape while the call still runs", async () => {
		const h = makeHarness(40);
		try {
			await h.scheduler.settle(h.terminal);
			await streamBash(h, 80);

			// (rows are asserted below)
			// The collapsed preview keeps a 10-row tail window; everything before it is
			// finalized output and must have been committed to scrollback, not dropped.
			// line-1..line-70 are absent from the tape today: the user can never scroll back to them.
			const rows = tape(h.terminal);
			const hasLine = (n: number) => rows.some(row => new RegExp(`\\bline-${n}\\b`).test(row));
			for (const n of [1, 2, 35, 69, 70]) expect({ n, onTape: hasLine(n) }).toEqual({ n, onTape: true });
			expect(rows.filter(row => /\bline-80\b/.test(row)).length).toBe(1);
		} finally {
			h.composer.stop();
		}
	});

	it("finishing the call neither duplicates history rows nor leaves a blank band", async () => {
		const h = makeHarness(40);
		try {
			await h.scheduler.settle(h.terminal);
			const card = await streamBash(h, 60);
			const lines = Array.from({ length: 60 }, (_, i) => `line-${i + 1}`);
			card.updateResult({ content: [{ type: "text", text: lines.join("\n") }] }, false);
			for (let i = 0; i < 4; i++) {
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
			}

			const rows = tape(h.terminal);
			expect(duplicatedTranscriptRows(rows)).toEqual([]);
			expect(missingTranscriptRows(rows, 40)).toEqual([]);
			expect(bracketedBlankRuns(rows)).toBe(0);
		} finally {
			h.composer.stop();
		}
	});
});

describe("bug 2 (stage shape): the command stage already in history is never redrawn differently", () => {
	// The early commit writes the command/code rows to scrollback once. Rows already there cannot change,
	// so anything that would redraw that stage with a different shape (a terminal that grows and widens the
	// preview window, ctrl+O expanding the code) must not produce a second copy of its rows.
	const CODE = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n");
	const COMMAND = Array.from({ length: 60 }, (_, i) => `echo step-${i}`).join("\n");

	interface Arm {
		name: string;
		initialRows: number;
		laterRows: number;
		expand: boolean;
	}
	const arms: Arm[] = [
		{ name: "the terminal grows mid-call", initialRows: 24, laterRows: 60, expand: false },
		{ name: "ctrl+O expands mid-call", initialRows: 40, laterRows: 40, expand: true },
		{ name: "both", initialRows: 24, laterRows: 60, expand: true },
	];

	async function codeRowCounts(tool: "bash" | "eval", arm: Arm): Promise<{ distinct: number; duplicated: number }> {
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const setRows = (rows: number): void => {
			Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
		};
		setRows(arm.initialRows);
		const h = makeHarness(40, 40);
		try {
			await h.scheduler.settle(h.terminal);
			const args = tool === "bash" ? { command: COMMAND } : { language: "js", title: "t", code: CODE };
			const card = new ToolExecutionComponent(tool, args, {}, undefined, h.composer.ui as unknown as TUI);
			cards.push(card);
			h.transcript.addChild(card);
			card.setArgsComplete();
			card.setExecutionStarted();
			const lines: string[] = [];
			const push = async (count: number) => {
				for (let i = 0; i < count; i++) {
					lines.push(`out-${lines.length + 1}`);
					const text = lines.join("\n");
					card.updateResult(
						tool === "bash"
							? { content: [{ type: "text", text }] }
							: {
									content: [{ type: "text", text }],
									details: {
										cells: [
											{ index: 0, language: "js", title: "t", code: CODE, status: "running", output: text },
										],
									},
								},
						true,
					);
					h.composer.ui.requestRender();
					await h.scheduler.settle(h.terminal);
				}
			};
			await push(15);
			setRows(arm.laterRows);
			if (arm.expand) card.setExpanded(true);
			await push(15);
			for (let i = 0; i < 4; i++) {
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
			}
			const marker = tool === "bash" ? /echo step-(\d+)/ : /const v(\d+) =/;
			const seen = new Map<string, number>();
			for (const row of tape(h.terminal)) {
				const match = marker.exec(row);
				if (match) seen.set(match[1]!, (seen.get(match[1]!) ?? 0) + 1);
			}
			return { distinct: seen.size, duplicated: [...seen].filter(([, n]) => n > 1).length };
		} finally {
			h.composer.stop();
			if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
			else Reflect.deleteProperty(process.stdout, "rows");
		}
	}

	for (const tool of ["bash", "eval"] as const) {
		for (const arm of arms) {
			it(`${tool}: ${arm.name} leaves each committed code row on the tape once`, async () => {
				const counts = await codeRowCounts(tool, arm);
				// Something was committed (otherwise "no duplicates" is vacuous), and nothing twice.
				expect(counts.distinct).toBeGreaterThan(0);
				expect(counts.duplicated).toBe(0);
			});
		}
	}
});

describe("bug 3: an edit card that is tall while pending and collapses to a short error keeps the chat on the bottom", () => {
	const ERROR_TEXT = "This edit anchors to lines 1636 of src/capture.rs that were not shown in a full read.";

	/** Unified-diff-shaped preview, `+<line>|<text>`, tall enough to fill the collapsed preview window. */
	function previewDiff(rows: number): string {
		return Array.from(
			{ length: rows },
			(_, i) => `+${String(i + 1).padStart(4, " ")}|    let value_${i} = ${i};`,
		).join("\n");
	}

	async function pendingEditCard(h: Harness): Promise<ToolExecutionComponent> {
		const card = new ToolExecutionComponent(
			"edit",
			{ path: "src/capture.rs", edits: [{ loc: "1", content: "x" }] },
			{},
			undefined,
			h.composer.ui as unknown as TUI,
		);
		cards.push(card);
		h.transcript.addChild(card);
		card.setArgsComplete();
		card.updateStreamPreview({ files: [{ path: "src/capture.rs", diff: previewDiff(40) }], streaming: false });
		card.setExecutionStarted();
		return card;
	}

	async function frames(h: Harness, count = 4): Promise<void> {
		for (let i = 0; i < count; i++) {
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
	}

	for (const history of [12, 30, 60]) {
		it(`history=${history}: the pending card is tall and the error leaves no blank band, no top blackbox, no lost or duplicated row`, async () => {
			const h = makeHarness(history);
			try {
				await h.scheduler.settle(h.terminal);
				const card = await pendingEditCard(h);
				await frames(h);
				const pendingRows = strip(h.terminal.getViewport());
				// The scenario only means something if the pending card really is tall.
				expect(pendingRows.filter(row => row.includes("let value_")).length).toBeGreaterThanOrEqual(8);

				card.updateResult({ content: [{ type: "text", text: ERROR_TEXT }], isError: true }, false);
				await frames(h, 6);

				const view = strip(h.terminal.getViewport());
				const rows = tape(h.terminal);
				// The editor sits directly under the (now short) error card. When the content overflows the
				// screen that is the last row: leaving it mid-screen with blank rows under it is the black
				// box the pending card's vanished height used to leave behind. A short session (history=12)
				// does not fill the screen, so its editor legitimately sits higher; there the invariant is
				// only that nothing but empty screen follows the editor.
				const editorRow = view.findIndex(row => row.includes("EDITOR"));
				expect(view[editorRow - 1]?.startsWith("╰")).toBe(true);
				expect(view.slice(editorRow + 1).every(row => row === "")).toBe(true);
				if (history >= 30) expect(editorRow).toBe(ROWS - 1);
				expect(bracketedBlankRuns(rows)).toBe(0);
				expect(missingTranscriptRows(rows, history)).toEqual([]);
				expect(duplicatedTranscriptRows(rows)).toEqual([]);
				const continuation = Array.from({ length: 50 }, (_, index) => `POST_EDIT_${index}`);
				h.transcript.addChild(new FixedRows(continuation));
				await frames(h, 6);
				const continuedTape = tape(h.terminal);
				expect(missingTranscriptRows(continuedTape, history)).toEqual([]);
				expect(duplicatedTranscriptRows(continuedTape)).toEqual([]);
				expect(continuedTape.flatMap(row => row.match(/POST_EDIT_\d+/g) ?? [])).toEqual(continuation);
				expect(bracketedBlankRuns(continuedTape)).toBe(0);
			} finally {
				h.composer.stop();
			}
		});
	}
});

describe("bug 4: the scrollbar-sized narrowing after a fullscreen overlay closes must not rewrite the whole interface", () => {
	async function openCloseWithResize(h: Harness, resizeTo: { columns: number; rows: number } | undefined) {
		const overlay = new FixedRows(Array.from({ length: ROWS }, (_, i) => `overlay row ${i}`));
		const handle = h.composer.ui.showOverlay(overlay, {
			anchor: "bottom-center",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		h.composer.ui.setFocus(overlay);
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		if (resizeTo) {
			h.terminal.resize(resizeTo.columns, resizeTo.rows);
			await h.scheduler.advance(h.terminal, 300);
		}
		handle.hide();
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		await h.scheduler.advance(h.terminal, 300);
		await h.scheduler.settle(h.terminal);
	}

	it("control: with no resize, open+close clears no scrollback and keeps every row exactly once", async () => {
		const h = makeHarness();
		try {
			await h.scheduler.settle(h.terminal);
			const clearsBefore = h.terminal.writes.split("\x1b[3J").length - 1;
			await openCloseWithResize(h, undefined);

			expect(h.terminal.writes.split("\x1b[3J").length - 1 - clearsBefore).toBe(0);
			const rows = tape(h.terminal);
			expect(missingTranscriptRows(rows, 60)).toEqual([]);
			expect(duplicatedTranscriptRows(rows)).toEqual([]);
		} finally {
			h.composer.stop();
		}
	});

	// Control (must stay as is): under the shipped default `tui.resizeScrollback = rebuild`, an
	// ordinary lasting width change IS a destructive replay. History committed at the old width is
	// wrapped wrong, so rebuild replaces it (tui.ts #prepareResizeReplay). Not a bug.
	it("control: an ordinary lasting width change under rebuild replays history (ED3) - intended", async () => {
		const h = makeHarness();
		try {
			await h.scheduler.settle(h.terminal);
			const clearsBefore = h.terminal.writes.split("\x1b[3J").length - 1;
			h.terminal.resize(COLUMNS - 20, ROWS);
			await h.scheduler.advance(h.terminal, 300);
			await h.scheduler.settle(h.terminal);
			await h.scheduler.advance(h.terminal, 300);
			expect(h.terminal.writes.split("\x1b[3J").length - 1 - clearsBefore).toBe(1);
		} finally {
			h.composer.stop();
		}
	});

	// The user's finding: while a fullscreen overlay owns the alt buffer the terminal's scrollbar is
	// gone; shortly AFTER the overlay closes the scrollbar returns and the grid narrows by its width
	// (k columns) and stays narrower. That narrowing is not a content reflow, so it must not trigger
	// the destructive full-interface rewrite that /advisor config and /usage users see on exit.
	// The final width must differ from the initial one: a round trip back would be a no-op.
	for (const k of [1, 2, 3]) {
		it(`a ${k}-column narrowing right after a fullscreen overlay closes does not clear scrollback or rewrite history`, async () => {
			const h = makeHarness();
			try {
				await h.scheduler.settle(h.terminal);
				const clearsBefore = h.terminal.writes.split("\x1b[3J").length - 1;
				const erasesBefore = h.terminal.writes.split("\x1b[2J").length - 1;

				const overlay = new FixedRows(Array.from({ length: ROWS }, (_, i) => `overlay row ${i}`));
				const handle = h.composer.ui.showOverlay(overlay, {
					anchor: "bottom-center",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
					fullscreen: true,
				});
				h.composer.ui.setFocus(overlay);
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
				handle.hide();
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
				// Seconds later the scrollbar returns and the grid stays narrower.
				await h.scheduler.advance(h.terminal, 2000);
				h.terminal.resize(COLUMNS - k, ROWS);
				await h.scheduler.advance(h.terminal, 300);
				await h.scheduler.settle(h.terminal);
				await h.scheduler.advance(h.terminal, 300);

				expect({
					ed3: h.terminal.writes.split("\x1b[3J").length - 1 - clearsBefore,
					ed2: h.terminal.writes.split("\x1b[2J").length - 1 - erasesBefore,
				}).toEqual({ ed3: 0, ed2: 0 });
				const rows = tape(h.terminal);
				expect(missingTranscriptRows(rows, 60)).toEqual([]);
				// The in-place repaint (same as `resizeScrollback=preserve`, measured with no overlay at all)
				// leaves at most the single viewport-top row duplicated in scrollback. The whole-history
				// doubling of an `append` replay (rows 0..45) and the full rewrite of `rebuild` are the
				// alternatives this fix exists to avoid, so cap the residue instead of demanding zero.
				expect(duplicatedTranscriptRows(rows).length).toBeLessThanOrEqual(1);
				// What the user actually sees must be intact: transcript tail directly above the editor.
				const view = strip(h.terminal.getViewport());
				expect(view.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
				expect(view.at(-2)).toBe(`${PREFIX}59`);
			} finally {
				h.composer.stop();
			}
		});
	}
});
