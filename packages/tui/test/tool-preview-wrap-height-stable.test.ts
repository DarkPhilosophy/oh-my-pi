import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";

withoutTerminalMultiplexer();

// Bug 5: a long line wraps onto extra PHYSICAL rows while the write preview window is budgeted in
// LOGICAL lines (`totalLines - PREVIEW_LIMITS.EXPANDED_LINES`). As content streams, the number of
// wrapped lines inside the sliding window varies chunk to chunk, so the card changes height every
// frame. A card may grow or shrink; what the user sees as the defect is the CHAT moving or leaving
// a black band under the tool. Oracle: terminal viewport, one paint at a time.

const COLUMNS = 80;
const ROWS = 30;
const HISTORY = 30;
const PREFIX = "Settled transcript row ";

const cards: ToolExecutionComponent[] = [];

beforeAll(async () => {
	await themeModule.initTheme();
});

afterEach(() => {
	for (const card of cards) card.stopAnimation();
	cards.length = 0;
});

/** Deterministic irregular line lengths: some short, some wrapping 2x/3x/4x. */
function irregularLines(count: number): string[] {
	let seed = 7;
	const next = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	return Array.from({ length: count }, (_, i) => {
		const r = next();
		const body = r < 0.4 ? 12 : r < 0.6 ? COLUMNS + 10 : r < 0.8 ? COLUMNS * 2 + 5 : COLUMNS * 3 + 21;
		return `const v_${i} = "${"x".repeat(body)}";`;
	});
}

const strip = (rows: string[]): string[] => rows.map(row => Bun.stripANSI(row).trimEnd());

describe("bug 5: a streaming write card with wrapping lines keeps the chat in place", () => {
	it("the editor never leaves the bottom row and no blank band opens under the card while it streams", async () => {
		const terminal = new VirtualTerminal(COLUMNS, ROWS);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		try {
			const transcript = new TranscriptContainer();
			for (let i = 0; i < HISTORY; i++) {
				const row = i;
				transcript.addChild({ render: () => [`${PREFIX}${row}`] });
			}
			composer.setRuntimeChildren([transcript, new Text("EDITOR", 0, 0)], {});
			composer.start({ playWelcomeIntro: false });
			await scheduler.settle(terminal);

			const lines = irregularLines(60);
			const card = new ToolExecutionComponent(
				"write",
				{ path: "big.ts", content: "" },
				{},
				undefined,
				composer.ui as unknown as TUI,
			);
			cards.push(card);
			transcript.addChild(card);
			card.setArgsComplete();
			card.setExecutionStarted();

			const editorRows: number[] = [];
			for (let n = 1; n <= lines.length; n++) {
				card.updateArgs({ path: "big.ts", content: lines.slice(0, n).join("\n") });
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				const view = strip(terminal.getViewport());
				editorRows.push(view.findIndex(row => row.includes("EDITOR")));
			}

			// The editor is pinned to the last row for every streamed chunk; any deviation is the chat
			// jumping up (card shrank) and leaving a black box underneath.
			expect(editorRows.filter(row => row !== ROWS - 1)).toEqual([]);
		} finally {
			composer.stop();
		}
	});
});

describe("bug 5: write preview height is stable while content streams past the window", () => {
	// First layer: the renderer itself. The user does not want the card to grow or shrink between
	// chunks even when no black box results (flicker / chaotic motion). Measured directly on
	// `renderCall`; the transcript's peak-hold layer would otherwise mask the oscillation.
	async function renderedHeights(lines: readonly string[]): Promise<number[]> {
		const theme = (await themeModule.getThemeByName("dark"))!;
		const heights: number[] = [];
		for (let n = 1; n <= lines.length; n++) {
			const component = writeToolRenderer.renderCall(
				{ path: "/tmp/big.ts", content: lines.slice(0, n).join("\n") },
				{ expanded: false, isPartial: true, spinnerFrame: 0 },
				theme,
			)!;
			heights.push(component.render(COLUMNS).length);
		}
		return heights;
	}

	it("height swings by less than one wrapped line once the window is full", async () => {
		// The window is sized in whole lines, so its height cannot be pinned exactly; the transcript
		// holds the card at its peak so the chat does not move. What must not happen is the swing the
		// logical-line window produced (12 wrapped lines of up to 4 rows each: 15 distinct heights).
		const heights = (await renderedHeights(irregularLines(80))).slice(30);
		const maxLineRows = 4;
		expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(maxLineRows);
	});

	it("the full window is bounded by the same physical-row budget as an unwrapped preview", async () => {
		const heights = await renderedHeights(irregularLines(80));
		const unwrapped = await renderedHeights(Array.from({ length: 80 }, (_, i) => `const s_${i} = ${i};`));
		expect(Math.max(...heights)).toBeLessThanOrEqual(Math.max(...unwrapped));
	});
});

describe("write preview window is the same while streaming and once finished", () => {
	// A different window at settle surfaces as a cut card and a blank gap: the rows already lent to
	// native scrollback no longer match the ones the finished card paints.
	for (const [label, lines] of [
		["no wrapping", Array.from({ length: 40 }, (_, i) => `const s_${i} = ${i};`)],
		["wrapping", irregularLines(40)],
	] as const) {
		it(`${label}: the numbered rows of the streamed card equal those of the finished card`, async () => {
			const theme = (await themeModule.getThemeByName("dark"))!;
			const content = lines.join("\n");
			const numbered = (rendered: readonly string[]): string[] =>
				rendered.map(row => Bun.stripANSI(row)).filter(row => /^│?\s*\d+ /.test(row));
			const hidden = (rendered: readonly string[]): string | undefined =>
				rendered.map(row => /\((\d+) earlier lines?\)/.exec(Bun.stripANSI(row))?.[1]).find(Boolean);
			const streamed = writeToolRenderer
				.renderCall(
					{ path: "/tmp/big.ts", content },
					{ expanded: false, isPartial: true, spinnerFrame: 0, argsComplete: true },
					theme,
				)!
				.render(COLUMNS);
			const finished = writeToolRenderer
				.renderResult(
					{ content: [{ type: "text", text: "Wrote /tmp/big.ts" }] },
					{ expanded: false, isPartial: false, spinnerFrame: 0 },
					theme,
					{ path: "/tmp/big.ts", content },
				)
				.render(COLUMNS);
			expect(numbered(finished)).toEqual(numbered(streamed));
			expect(hidden(finished)).toBe(hidden(streamed));
		});
	}
});

describe("write preview elision marker never wraps onto a second row", () => {
	// The marker grows with its counters (`28` -> `128`, `12 of 40` -> `12 of 140`). If it can wrap,
	// the card gains a row exactly when a counter crosses a digit boundary, in the middle of a stream.
	for (const width of [24, 30, 40, 80]) {
		it(`width ${width}: the marker occupies one row for 40 and for 400 lines`, async () => {
			const theme = (await themeModule.getThemeByName("dark"))!;
			const markerRows = (total: number): number =>
				writeToolRenderer
					.renderCall(
						{ path: "/tmp/big.ts", content: Array.from({ length: total }, (_, i) => `s${i}`).join("\n") },
						{ expanded: false, isPartial: true, spinnerFrame: 0 },
						theme,
					)!
					.render(width)
					.map(row => Bun.stripANSI(row))
					.filter(row => /earlier|showing|of \d+\)/.test(row)).length;
			expect([markerRows(40), markerRows(400)]).toEqual([1, 1]);
		});
	}
});

describe("bash output elision marker never wraps onto a second row", () => {
	// Same hazard as write, on the surface used by bash/eval: the canonical marker is ~20 columns wider
	// than the old one, so below ~56 columns it wrapped and the card grew by a row.
	for (const width of [24, 30, 40, 80]) {
		it(`width ${width}: one marker row, no orphan continuation, same card height for 40 and 400 lines`, () => {
			const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
			const render = (total: number): string[] => {
				const card = new ToolExecutionComponent("bash", { command: "seq 1 80" }, {}, undefined, ui);
				cards.push(card);
				card.setArgsComplete();
				card.setExecutionStarted();
				card.updateResult(
					{ content: [{ type: "text", text: Array.from({ length: total }, (_, i) => `line-${i}`).join("\n") }] },
					true,
				);
				return card.render(width).map(row => Bun.stripANSI(row).trimEnd());
			};
			const small = render(40);
			const large = render(400);
			const markerRows = (rows: string[]): string[] => rows.filter(row => /earlier|showing \d+ of/.test(row));
			expect([markerRows(small).length, markerRows(large).length]).toEqual([1, 1]);
			// The counters gain a digit between 40 and 400 lines; the card must not.
			expect(large.length).toBe(small.length);
		});
	}
});

describe("bash command elision marker never wraps onto a second row", () => {
	// `capPreviewLines` caps a long command behind the same marker; it is shared by bash and task.
	for (const width of [24, 30, 40, 80]) {
		it(`width ${width}: a long pending command keeps one marker row and the same height at 40 and 400 lines`, () => {
			const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
			const render = (total: number): string[] => {
				const command = Array.from({ length: total }, (_, i) => `echo step-${i}`).join("\n");
				const card = new ToolExecutionComponent("bash", { command }, {}, undefined, ui);
				cards.push(card);
				card.setArgsComplete();
				return card.render(width).map(row => Bun.stripANSI(row).trimEnd());
			};
			const small = render(40);
			const large = render(400);
			const markerRows = (rows: string[]): number => rows.filter(row => /earlier|showing \d+ of/.test(row)).length;
			expect([markerRows(small), markerRows(large)]).toEqual([1, 1]);
			expect(large.length).toBe(small.length);
		});
	}
});

describe("write preview window contract without wrapping", () => {
	it("still shows the last 12 logical lines with their numbers", async () => {
		const theme = (await themeModule.getThemeByName("dark"))!;
		const content = Array.from({ length: 40 }, (_, i) => `const s_${i} = ${i};`).join("\n");
		const rows = writeToolRenderer
			.renderCall({ path: "/tmp/big.ts", content }, { expanded: false, isPartial: true, spinnerFrame: 0 }, theme)!
			.render(COLUMNS)
			.map(row => Bun.stripANSI(row));
		const text = rows.join("\n");
		expect(text).toContain("… (28 earlier lines, showing 12 of 40)");
		expect(text).toContain(" 29 const s_28 = 28;");
		expect(text).toContain(" 40 const s_39 = 39;");
		expect(text).not.toContain(" 28 const s_27 = 27;");
	});
});
