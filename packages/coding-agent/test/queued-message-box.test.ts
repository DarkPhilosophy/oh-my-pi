import { beforeAll, describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { QueuedMessageBox } from "../src/modes/components/queued-message-box";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(() => {
	initTheme();
});

// Strip ANSI SGR so structural assertions match the glyphs.
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (rows: readonly string[]): string[] => rows.map(r => r.replace(ansi, ""));

describe("QueuedMessageBox", () => {
	it("frames lines with a titled top rule, guttered body, and a bottom rule", () => {
		const box = new QueuedMessageBox("Steer", ["alpha", "beta"], { collapseLines: 5, expanded: true });
		const rows = plain(box.render(40));
		expect(rows).toHaveLength(4); // top + 2 body + bottom
		expect(rows[0]).toContain("╭");
		expect(rows[0]).toContain("Steer"); // title inset into the top rule
		expect(rows[1]).toContain("├─"); // first logical line → new tree item
		expect(rows[1]).toContain("alpha");
		expect(rows[2]).toContain("└─"); // last logical line → closes the tree
		expect(rows[2]).toContain("beta");
		expect(rows[3]).toContain("╰");
	});

	it("keeps every rendered row exactly the box width", () => {
		const box = new QueuedMessageBox("Follow-up", ["one", "two", "three"], { collapseLines: 5, expanded: true });
		const width = 50;
		for (const line of box.render(width)) expect(visibleWidth(line)).toBe(width);
	});

	it("collapses overflow into a bottom-border hint (+N rows · M chars)", () => {
		// Seven short logical lines, collapsed to 3 visual rows.
		const lines = ["a", "b", "c", "d", "e", "f", "g"];
		const box = new QueuedMessageBox("Steer", lines, { collapseLines: 3, expanded: false });
		const rows = plain(box.render(40));
		expect(rows).toHaveLength(5); // top + 3 body + bottom
		expect(rows[4]).toContain("+4 rows"); // 7 total − 3 shown
		expect(rows[4]).toContain("chars");
	});

	it("wraps a long line onto continuation rows with the soft-wrap gutter", () => {
		// Two logical lines: the first is long (wraps → soft-wrap `│ ` continuations,
		// opening with `├─`); the second is the last logical line (`└─`).
		const box = new QueuedMessageBox("", ["a fairly long line that must wrap onto more rows", "tail"], {
			collapseLines: 5,
			expanded: true,
			showTopBorder: false,
		});
		const rows = plain(box.render(24));
		expect(rows.some(r => r.includes("├─"))).toBe(true); // first logical line opens the tree
		expect(rows.some(r => r.includes("│ "))).toBe(true); // wrapped continuation of line 1
		expect(rows.some(r => r.includes("└─"))).toBe(true); // last logical line closes the tree
	});

	it("renders an empty body row when there are no lines so the frame stays closed", () => {
		const box = new QueuedMessageBox("Steer", [], { collapseLines: 5, expanded: true });
		const rows = plain(box.render(30));
		expect(rows).toHaveLength(3); // top + one empty body row + bottom
		expect(rows[0]).toContain("╭");
		expect(rows[2]).toContain("╰");
	});

	it("omits its own top rule when showTopBorder is false (caller supplies it)", () => {
		const box = new QueuedMessageBox("", ["alpha", "beta"], {
			collapseLines: 5,
			expanded: true,
			showTopBorder: false,
		});
		const rows = plain(box.render(40));
		expect(rows).toHaveLength(3); // body x2 + bottom, NO top rule
		expect(rows[0]).toContain("╎"); // first row is a body row with dashed verticals, not a top border
		expect(rows[0]).not.toContain("╭");
		expect(rows[0]).toContain("alpha");
		expect(rows[2]).toContain("╰");
		for (const line of box.render(40)) expect(visibleWidth(line)).toBe(40);
	});

	it("drops the empty-title label in the narrow fallback (steer box has no title)", () => {
		const box = new QueuedMessageBox("", ["x", "y"], { collapseLines: 5, expanded: true, showTopBorder: false });
		const rows = plain(box.render(4));
		expect(rows.some(r => r.includes(":"))).toBe(false); // no bare `:` label line
		expect(rows.some(r => r.trim() === "x")).toBe(true);
	});

	it("falls back to plain indented rows when the width is too narrow to frame", () => {
		const box = new QueuedMessageBox("Steer", ["x", "y"], { collapseLines: 5, expanded: true });
		const rows = plain(box.render(4));
		expect(rows[0]).toContain("Steer:");
		expect(rows.some(r => r.includes("╭"))).toBe(false); // no frame at tiny width
		expect(rows.some(r => r.trim() === "x")).toBe(true);
	});

	it("caches by width and invalidates on demand", () => {
		const box = new QueuedMessageBox("Steer", ["a"], { collapseLines: 5, expanded: true });
		const first = box.render(20);
		expect(box.render(20)).toBe(first); // same reference when width unchanged
		expect(box.render(30)).not.toBe(first); // re-render at a new width
		box.invalidate();
		expect(box.render(20)).not.toBe(first); // fresh array after invalidate
	});
});
