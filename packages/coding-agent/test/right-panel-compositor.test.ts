import { describe, expect, it } from "bun:test";
import { compositeRightPanel, compositeRightPanels } from "../src/modes/interactive-mode";

// A 20-column panel: ┌──┐ / body / └──┘. Plain ASCII so visibleWidth === length.
function panel(lines: number): string[] {
	const top = `┌${"─".repeat(18)}┐`;
	const bottom = `└${"─".repeat(18)}┘`;
	const body = Array.from({ length: Math.max(0, lines - 2) }, (_, i) => `│ row ${String(i).padEnd(11)}│`);
	return [top, ...body, bottom];
}

const WIDTH = 80; // col = 80 - 20 - 1 = 59
const COL = 59;

describe("compositeRightPanel", () => {
	it("returns base lines untouched when the panel is empty", () => {
		const base = ["a", "b", "c"];
		expect(compositeRightPanel(base, [], WIDTH, 40)).toBe(base);
	});

	it("hides (returns base unchanged) when the terminal is too narrow", () => {
		const base = Array.from({ length: 12 }, () => "");
		// width 40 → col = 40 - 20 - 1 = 19 < 30
		expect(compositeRightPanel(base, panel(8), 40, 40)).toEqual(base);
	});

	it("hides when every visible row already reaches the panel column", () => {
		const base = Array.from({ length: 12 }, () => "x".repeat(COL + 1)); // wider than col
		const out = compositeRightPanel(base, panel(8), WIDTH, 40);
		expect(out).toEqual(base);
	});

	it("hides when the only free run is shorter than 6 rows", () => {
		// 4 short rows then a long row breaks the run; nothing else fits.
		const base = ["", "", "", "", "x".repeat(COL + 1)];
		const out = compositeRightPanel(base, panel(8), WIDTH, 40);
		expect(out).toEqual(base);
	});

	it("hides when the visible viewport is below the minimum panel height", () => {
		const base = Array.from({ length: 20 }, () => "");
		const out = compositeRightPanel(base, panel(8), WIDTH, 5);
		expect(out).toEqual(base);
	});

	it("places the panel on a free run without overwriting visible text", () => {
		const base = Array.from({ length: 12 }, () => "hi"); // all width 2 <= col
		const widget = panel(8);
		const out = compositeRightPanel(base, widget, WIDTH, 40);

		expect(out).toHaveLength(base.length);
		for (let k = 0; k < widget.length; k++) {
			// base content preserved on the left, panel appended on the right
			expect(out[k].startsWith("hi")).toBe(true);
			expect(out[k].endsWith(widget[k])).toBe(true);
		}
		// rows past the panel are untouched
		expect(out[widget.length]).toBe("hi");
	});

	it("hides instead of cutting a widget when the free run is shorter than the panel", () => {
		// A run of exactly 8 short rows, then a long row; widget wants 12 rows.
		const base = [...Array.from({ length: 8 }, () => ""), "x".repeat(COL + 1), "", ""];
		const widget = panel(12);
		const out = compositeRightPanel(base, widget, WIDTH, 40);

		expect(out).toEqual(base);
	});

	it("searches only the visible viewport, not scrolled-off history", () => {
		// 100 short rows but a tiny viewport: the panel must land near the bottom.
		const base = Array.from({ length: 100 }, (_, i) => `line ${i}`);
		const widget = panel(8);
		const out = compositeRightPanel(base, widget, WIDTH, 10);
		// Top rows stay clean; the panel is placed within the last ~10 rows.
		expect(out[0]).toBe("line 0");
		const placed = out.findIndex(line => line.endsWith(widget[0]));
		expect(placed).toBeGreaterThanOrEqual(base.length - 10);
	});

	it("never composites over a terminal image block", () => {
		const widget = panel(8);
		const isImage = (l: string) => l === "IMG";
		// 5 blank placeholder rows + the raw image escape line, then free rows.
		const base = ["", "", "", "", "", "IMG", ...Array.from({ length: 12 }, () => "hi")];

		// Without image awareness the run swallows the image block (the bug).
		const naive = compositeRightPanel(base, widget, WIDTH, 40);
		expect(naive.some((line, i) => i <= 5 && line.endsWith(widget[0]))).toBe(true);

		// With image awareness the panel lands strictly below the image block.
		const safe = compositeRightPanel(base, widget, WIDTH, 40, isImage);
		expect(safe[5]).toBe("IMG"); // image escape line untouched
		for (let i = 0; i <= 5; i++) expect(safe[i].endsWith(widget[0])).toBe(false);
		expect(safe.findIndex(line => line.endsWith(widget[0]))).toBeGreaterThan(5);
	});
});

describe("compositeRightPanels", () => {
	it("composites multiple blocks independently onto distinct rows", () => {
		const base = Array.from({ length: 12 }, () => "hi"); // all width 2 <= col
		// Distinct content per block (panel() borders are identical and unusable here).
		const a = ["A0", "A1", "A2", "A3"];
		const b = ["B0", "B1", "B2"];
		const out = compositeRightPanels(base, [a, b], WIDTH, 40);

		expect(out).toHaveLength(base.length);
		const aAt = out.findIndex(line => line.endsWith("A0"));
		const bAt = out.findIndex(line => line.endsWith("B0"));
		expect(aAt).toBeGreaterThanOrEqual(0);
		expect(bAt).toBeGreaterThanOrEqual(0);
		// Distinct, non-overlapping placements (a occupies aAt..aAt+3).
		expect(bAt).toBeGreaterThanOrEqual(aAt + a.length);
	});

	it("drops only the block that does not fit and keeps the rest", () => {
		// 5 free rows then a wall: a 4-row block fits, a 12-row block cannot.
		const base = ["", "", "", "", "", "x".repeat(COL + 1)];
		const small = ["S0", "S1", "S2", "S3"];
		const big = Array.from({ length: 12 }, (_, i) => `B${i}`);
		const out = compositeRightPanels(base, [small, big], WIDTH, 40);

		expect(out.some(line => line.endsWith("S0"))).toBe(true);
		expect(out.some(line => line.endsWith("B0"))).toBe(false);
	});

	it("returns base unchanged when no block fits", () => {
		const base = Array.from({ length: 4 }, () => ""); // only 4 free rows
		const out = compositeRightPanels(base, [panel(8)], WIDTH, 40);
		expect(out).toEqual(base);
	});

	it("places earlier blocks first, claiming space before later ones", () => {
		// Two separate 4-row gaps split by a wall.
		const base = ["", "", "", "", "x".repeat(COL + 1), "", "", "", ""];
		const first = panel(4);
		const second = panel(4);
		const out = compositeRightPanels(base, [first, second], WIDTH, 40);

		expect(out[0].endsWith(first[0])).toBe(true);
		expect(out[5].endsWith(second[0])).toBe(true);
	});

	it("returns base unchanged when there are no blocks", () => {
		const base = ["a", "b", "c"];
		expect(compositeRightPanels(base, [], WIDTH, 40)).toBe(base);
	});
});
