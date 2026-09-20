import { beforeAll, describe, expect, it } from "bun:test";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();

const ROWS = 40;
const COLUMNS = 100;
const TRANSCRIPT_ROWS = 60;
const TRANSCRIPT_PREFIX = "Settled transcript row ";

/** Below-transcript chrome that inflates on demand, mimicking a confirmation dialog or a tall multi-line editor swapped in above the input. */
class InlineWidget implements Component {
	rows = 0;

	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, i) => `Live widget row ${i}`);
	}
}

/** A live card whose visible tail follows the allocator's current frame budget. */
class AllocationAwareTransientCard implements Component {
	#allocation = Number.MAX_SAFE_INTEGER;

	constructor(private readonly rows: readonly string[]) {}

	isTranscriptBlockFinalized(): boolean {
		return false;
	}

	isTranscriptBlockTransient(): boolean {
		return true;
	}

	setTranscriptAllocation(rows: number): void {
		this.#allocation = rows;
	}

	render(): readonly string[] {
		return this.rows.slice(-this.#allocation);
	}
}

interface Harness {
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	transcript: TranscriptContainer;
	widget: InlineWidget;
}

function makeHarness(): Harness {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	for (let i = 0; i < TRANSCRIPT_ROWS; i++) {
		const row = i;
		transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${row}`] });
	}
	const editor = new Container();
	const widget = new InlineWidget();
	editor.addChild(widget);
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, editor]);
	composer.start({ playWelcomeIntro: false });
	return { terminal, scheduler, composer, transcript, widget };
}

/** Settle, grow the inline chrome, settle, shrink it back, settle. */
async function cycleWidget(h: Harness): Promise<void> {
	await h.scheduler.settle(h.terminal);
	h.widget.rows = 24;
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
	h.widget.rows = 0;
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
}

function hasBracketedBlankRun(rows: readonly string[]): boolean {
	for (let index = 0; index < rows.length; index++) {
		if (rows[index] === "") continue;
		let end = index + 1;
		while (rows[end] === "") end++;
		if (end - index - 1 >= 2 && end < rows.length) return true;
	}
	return false;
}

beforeAll(async () => {
	await initTheme();
});

describe("composer inline shrink (#11007)", () => {
	it("reserves a mutable transient card at this frame's allocation after its live budget shrinks", () => {
		const terminal = new VirtualTerminal(COLUMNS, ROWS);
		const composer = new Composer({
			terminal,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		const card = new AllocationAwareTransientCard(Array.from({ length: ROWS * 2 }, (_, i) => `CARD ${i}`));
		const editor = new Container();
		const widget = new InlineWidget();
		transcript.addChild(card);
		editor.addChild(widget);
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, editor]);
		composer.start({ playWelcomeIntro: false });

		const tall = composer.renderFrame({ columns: COLUMNS, rows: ROWS });
		expect(tall.viewport.filter(row => row.includes("CARD"))).toHaveLength(ROWS - 1);

		widget.rows = 30;
		const short = composer.renderFrame({ columns: COLUMNS, rows: ROWS });
		const cardRows = short.viewport.filter(row => row.includes("CARD"));
		expect(cardRows).toHaveLength(ROWS - 31);
		// The prior 39-row allocation must not reserve rows the 9-row card no
		// longer occupies in this frame.
		expect(short.viewportExpansionRows).toBe(cardRows.length);
		composer.stop();
	});

	it("keeps the editor pinned to the bottom after transient below-transcript chrome shrinks", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		const before = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(before.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);

		await cycleWidget(h);

		const after = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		// Regression: the editor used to strand ~24 blank rows below it after the
		// shrink because retired transcript rows never returned to the live tail.
		expect(after.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);
		const lastContent = after.reduce((last, row, i) => (row.length > 0 ? i : last), -1);
		expect(lastContent).toBe(ROWS - 1);

		h.composer.stop();
	});

	it("retires transcript rows contiguously with no duplication or gaps across the grow/shrink cycle", async () => {
		const h = makeHarness();
		await cycleWidget(h);

		// Every transcript row appears exactly once (native scrollback + live grid),
		// in order — the shrink must not drop rows into a gap or duplicate them.
		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));

		h.composer.stop();
	});

	// KNOWN FAILURE. A live-frame contraction erases from `previousTop` and writes
	// its shorter frame at `startTop`, leaving the vacated rows blank and resident
	// on screen; the next overflowing paint then scrolls those blanks into native
	// scrollback, where they are permanent. Three repairs were tried and rejected:
	// rebasing the frame to `previousTop` and deleting the vacated lines both break
	// bottom anchoring (the editor stops being pinned to the last row), and reusing
	// the forced history replay is O(entire transcript) and destroys native history.
	// A real fix needs a provider capability to repaint a bounded slice of retained
	// history into the vacated range; `TerminalFrameProvider` has no such operation
	// today. Flip this to `it` once that lands.
	it.failing(
		"does not scroll erase-manufactured blank runs into native history while live content contracts",
		async () => {
			const h = makeHarness();
			try {
				await h.scheduler.settle(h.terminal);
				for (let iteration = 0; iteration < 4; iteration++) {
					h.widget.rows = 24;
					h.composer.ui.requestRender();
					await h.scheduler.settle(h.terminal);
					h.widget.rows = 0;
					h.composer.ui.requestRender();
					await h.scheduler.settle(h.terminal);
					h.transcript.addChild({ render: () => [`Streamed transcript row ${iteration}`] });
					h.composer.ui.requestRender();
					await h.scheduler.settle(h.terminal);
				}

				const surface = h.terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
				expect(hasBracketedBlankRun(surface)).toBe(false);
			} finally {
				h.composer.stop();
			}
		},
	);

	it("keeps the below-chrome baseline across a height resize while inline chrome is expanded", async () => {
		const shorter = ROWS - 10;
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// Expand, resize the terminal height *while still expanded*, then keep
		// rendering before shrinking. The retirement baseline must not adopt the
		// expanded peak at the resize, or the frames before the shrink retire
		// rows the shrink cannot reclaim and the editor is stranded again.
		h.widget.rows = 24;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		h.terminal.resize(COLUMNS, shorter);
		await h.scheduler.advance(h.terminal, 300);
		for (let frame = 0; frame < 5; frame++) {
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const after = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(after.findIndex(row => row.includes("EDITOR"))).toBe(shorter - 1);
		const lastContent = after.reduce((last, row, i) => (row.length > 0 ? i : last), -1);
		expect(lastContent).toBe(shorter - 1);

		h.composer.stop();
	});

	it("clips the live tail from the top instead of compacting it when the chrome grows a few rows", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// A persistent few-row growth (multi-line prompt, todo HUD, subagent badge)
		// lifts the chrome above the retirement baseline. The tail must scroll
		// off the top like native history would — not collapse into the
		// one-row-per-block emergency layout that drops every inter-block blank
		// and strands the freed rows below the editor.
		h.widget.rows = 3;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const editorRow = view.findIndex(row => row.includes("EDITOR"));
		expect(editorRow).toBe(ROWS - 1);
		const transcriptRows = view.slice(0, editorRow - 3);
		const separators = transcriptRows.filter(
			(row, i) => row === "" && transcriptRows[i - 1]?.startsWith(TRANSCRIPT_PREFIX),
		);
		expect(separators.length).toBeGreaterThan(0);
		expect(transcriptRows.at(-1)).toBe(`${TRANSCRIPT_PREFIX}${TRANSCRIPT_ROWS - 1}`);

		h.composer.stop();
	});
});
