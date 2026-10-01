import { beforeAll, describe, expect, it } from "bun:test";
import { renderOutputBlock } from "@oh-my-pi/pi-tui/render/output-block";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-tui/theme";

// A staged block draws two boxes, each as wide as its own content, joined by one connector row:
//
//   short top, long bottom         long top, short bottom
//   ╭──Eval ───────╮               ╭──Eval ──────────────────╮
//   │ short code   │               │ a very long line of code│
//   ├── Output ────┴──────────╮    ├── Output ───┬───────────╯
//   │ a long output line here │    │ short out   │
//   ╰─────────────────────────╯    ╰─────────────╯
//
// The top stage never changes width once its content is known, so its rows can be committed to
// history; only the connector row and the lower box follow the output.

let theme: Theme;

beforeAll(async () => {
	await initTheme();
	theme = (await getThemeByName("dark"))!;
});

const ROW = 80;

function render(code: string, output: string): string[] {
	return renderOutputBlock(
		{
			header: "Eval",
			state: "running",
			stageTone: "success",
			width: ROW,
			fitToContent: true,
			sections: [{ lines: [code] }, { label: "Output Running", lines: [output] }],
		},
		theme,
	).map(row => Bun.stripANSI(row));
}

const widthOf = (row: string): number => [...row].length;

describe("two-width staged box", () => {
	it("short code over long output: the lower box is wider and the connector closes the top box with ┴", () => {
		const rows = render("echo lol", "a much longer output line than the code above it");
		const top = rows.findIndex(row => row.startsWith("╭"));
		const connector = rows.findIndex(row => row.startsWith("├"));
		expect(widthOf(rows[top]!)).toBeLessThan(widthOf(rows[connector]!));
		expect(rows[connector]).toContain("┴");
		expect(rows[connector]!.trimEnd().endsWith("╮")).toBe(true);
	});

	it("long code over short output: the lower box is narrower and the connector closes with ┬ and ╯", () => {
		const rows = render("a very long line of code that is much wider than the output below", "ok");
		const top = rows.findIndex(row => row.startsWith("╭"));
		const connector = rows.findIndex(row => row.startsWith("├"));
		expect(widthOf(rows[connector]!)).toBe(widthOf(rows[top]!));
		expect(rows[connector]).toContain("┬");
		expect(rows[connector]!.trimEnd().endsWith("╯")).toBe(true);
		const bottom = rows.findLast(row => row.startsWith("╰"))!;
		expect(widthOf(bottom)).toBeLessThan(widthOf(rows[top]!));
	});

	it("the top box never changes width or bytes when the output changes", () => {
		const a = render("echo lol", "ok");
		const b = render("echo lol", "a much longer output line than the code above it");
		const c = render("echo lol", "x".repeat(200));
		expect(b.slice(0, 2)).toEqual(a.slice(0, 2));
		expect(c.slice(0, 2)).toEqual(a.slice(0, 2));
	});

	it("wide output wraps at the row width, not at the narrow top box", () => {
		const rows = render("echo lol", "y".repeat(200));
		expect(rows.every(row => widthOf(row) <= ROW)).toBe(true);
		expect(Math.max(...rows.map(widthOf))).toBe(ROW);
	});

	it("the lower box never gets narrower than its own separator label", () => {
		const rows = render("same width!!", "same width!!");
		const connector = rows.find(row => row.startsWith("├"))!;
		expect(connector).toContain("Output Running");
		expect(connector).not.toContain("…");
	});

	it("equal widths close the connector like an ordinary separator", () => {
		const rows = renderOutputBlock(
			{
				header: "Eval",
				state: "running",
				stageTone: "success",
				width: 40,
				fitToContent: true,
				sections: [{ lines: ["x".repeat(30)] }, { label: "Out", lines: ["y".repeat(30)] }],
			},
			theme,
		).map(row => Bun.stripANSI(row));
		const connector = rows.find(row => row.startsWith("├"))!;
		expect(connector.trimEnd().endsWith("┤")).toBe(true);
		expect(connector).not.toMatch(/[┬┴]/);
	});
});

describe("connector row colour", () => {
	// The label carries its own reset, so the connector must colour its border segments one by one, like an
	// ordinary separator bar does. One border() around the whole row left everything after the label (the
	// status text, the tee and the closing corner) in the terminal default, visibly whiter than the frame.
	const rawConnector = (topCode: string, liveOutput: string): string => {
		const rows = renderOutputBlock(
			{
				header: "Bash",
				state: "running",
				stageTone: "success",
				width: 60,
				fitToContent: true,
				// Styled like the tools do: the label ends with its own foreground reset.
				sections: [
					{ lines: [topCode] },
					{ label: `${theme.fg("toolTitle", "Output")} Running`, lines: [liveOutput] },
				],
			},
			theme,
		);
		return rows.find(row => Bun.stripANSI(row).startsWith("├"))!;
	};
	/** Text after the label that is drawn while the terminal default foreground is active. */
	const uncolouredBorderGlyphs = (raw: string): string => {
		let colour = false;
		let glyphs = "";
		const re = /\x1b\[([0-9;]*)m|([^\x1b])/g;
		for (let m = re.exec(raw); m; m = re.exec(raw)) {
			if (m[1] !== undefined) {
				if (m[1] === "39" || m[1] === "0") colour = false;
				else if (m[1].startsWith("38;")) colour = true;
			} else if (!colour && /[├┤┬┴╮╯─╭╰]/.test(m[2]!)) glyphs += m[2];
		}
		return glyphs;
	};

	it("unequal widths: the tee, the fill and the closing corner keep the border colour", () => {
		expect(uncolouredBorderGlyphs(rawConnector("short", "y".repeat(40)))).toBe("");
	});

	it("equal widths: the closing tee keeps the border colour", () => {
		expect(uncolouredBorderGlyphs(rawConnector("x".repeat(30), "y".repeat(30)))).toBe("");
	});
});
