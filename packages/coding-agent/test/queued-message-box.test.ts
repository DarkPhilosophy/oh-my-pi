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
	it("frames lines with a titled top rule, body rows, and a bottom rule", () => {
		const box = new QueuedMessageBox("Steer", ["alpha", "beta"]);
		const rows = plain(box.render(40));
		expect(rows).toHaveLength(4); // top + 2 body + bottom
		expect(rows[0]).toContain("╭");
		expect(rows[0]).toContain("Steer"); // title inset into the top rule
		expect(rows[1]).toContain("│");
		expect(rows[1]).toContain("alpha");
		expect(rows[2]).toContain("beta");
		expect(rows[3]).toContain("╰");
	});

	it("keeps every rendered row exactly the box width", () => {
		const box = new QueuedMessageBox("Follow-up", ["one", "two", "three"]);
		const width = 50;
		for (const line of box.render(width)) {
			expect(visibleWidth(line)).toBe(width);
		}
	});

	it("appends the suffix to the last body row only", () => {
		const box = new QueuedMessageBox("Steer", ["first", "last"], " (+3)");
		const rows = plain(box.render(40));
		expect(rows[1]).toContain("first");
		expect(rows[1]).not.toContain("(+3)");
		expect(rows[2]).toContain("last");
		expect(rows[2]).toContain("(+3)");
	});

	it("renders an empty body row when there are no lines so the frame stays closed", () => {
		const box = new QueuedMessageBox("Steer", []);
		const rows = plain(box.render(30));
		expect(rows).toHaveLength(3); // top + one empty body row + bottom
		expect(rows[0]).toContain("╭");
		expect(rows[2]).toContain("╰");
	});

	it("falls back to plain indented rows when the width is too narrow to frame", () => {
		const box = new QueuedMessageBox("Steer", ["x", "y"]);
		const rows = plain(box.render(4));
		expect(rows[0]).toContain("Steer:");
		expect(rows.some(r => r.includes("╭"))).toBe(false); // no frame at tiny width
		expect(rows.some(r => r.trim() === "x")).toBe(true);
	});

	it("caches by width and invalidates on demand", () => {
		const box = new QueuedMessageBox("Steer", ["a"]);
		const first = box.render(20);
		expect(box.render(20)).toBe(first); // same reference when width unchanged
		expect(box.render(30)).not.toBe(first); // re-render at a new width
		box.invalidate();
		expect(box.render(20)).not.toBe(first); // fresh array after invalidate
	});
});
