import { beforeAll, describe, expect, it } from "bun:test";
import type { EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { evalToolRenderer } from "@oh-my-pi/pi-tui/tools/eval";
import { previewWindowRows } from "@oh-my-pi/pi-tui/render/render-utils";

/**
 * Defends the bounded code-window contract for eval cells: collapsed views cap
 * the cell source to a viewport-sized TAIL window (the end stays visible, the
 * head is elided behind an "earlier lines" marker) in BOTH the pending preview
 * and the final result, so a long cell neither floods the transcript nor snaps
 * open when the result lands. Only ctrl+o (expanded) uncaps.
 */
describe("eval renderer: viewport tail window for cell code", () => {
	let theme: Theme;
	const total = previewWindowRows() + 5;
	const code = Array.from({ length: total }, (_, i) => `value_${i} = ${i}`).join("\n");
	const firstLine = "value_0 = 0";
	const lastLine = `value_${total - 1} = ${total - 1}`;

	beforeAll(async () => {
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		setThemeInstance(theme);
	});

	function renderResult(expanded: boolean): string {
		const details: EvalToolDetails = {
			language: "python",
			languages: ["python"],
			cells: [{ index: 0, code, language: "python", output: "", status: "complete", statusEvents: [] }],
		};
		const component = evalToolRenderer.renderResult(
			{ content: [{ type: "text", text: "" }], details },
			{ expanded, isPartial: false, spinnerFrame: 0 },
			theme,
		);
		return Bun.stripANSI(component.render(120).join("\n"));
	}

	it("caps collapsed result code to the tail window with an earlier-lines marker", () => {
		const rendered = renderResult(false);
		expect(rendered).toContain(lastLine);
		expect(rendered).toContain("earlier line");
		expect(rendered).not.toContain(firstLine);
	});

	it("shows the full source when expanded", () => {
		const rendered = renderResult(true);
		expect(rendered).toContain(firstLine);
		expect(rendered).toContain(lastLine);
		expect(rendered).not.toContain("earlier line");
	});

	it("bounds the pending preview to the same live tail window", () => {
		const component = evalToolRenderer.renderCall(
			{ language: "py", code },
			{ expanded: false, isPartial: true },
			theme,
		);
		const rendered = Bun.stripANSI(component.render(120).join("\n"));
		// Newest streamed line stays visible; earliest lines are elided above it.
		expect(rendered).toContain(lastLine);
		expect(rendered).toContain("earlier line");
		expect(rendered).not.toContain(firstLine);
	});

	it("hides a dangling one-character streamed line until eval arguments complete", () => {
		const partial = evalToolRenderer.renderCall(
			{ language: "js", code: "const value = 1;\nc" },
			{ expanded: false, isPartial: true, argsComplete: false },
			theme,
		);
		const complete = evalToolRenderer.renderCall(
			{ language: "js", code: "const value = 1;\nc" },
			{ expanded: false, isPartial: true, argsComplete: true },
			theme,
		);
		expect(Bun.stripANSI(partial.render(120).join("\n"))).not.toContain("│ c ");
		expect(Bun.stripANSI(complete.render(120).join("\n"))).toContain("│ c ");
	});

	it("keeps structured display previews inside the eval cell output section", () => {
		const details: EvalToolDetails = {
			language: "js",
			languages: ["js"],
			jsonOutputs: [{ preview: { ok: true } }],
			cells: [{ index: 0, code: "display(r)", language: "js", output: "", status: "complete", statusEvents: [] }],
		};
		const rendered = evalToolRenderer
			.renderResult({ content: [{ type: "text", text: "" }], details }, { expanded: false, isPartial: false }, theme)
			.render(120)
			.map(line => Bun.stripANSI(line));
		const previewRow = rendered.findIndex(line => line.includes("preview"));
		const bottomBorder = rendered.findIndex(line => line.startsWith("╰"));
		expect(previewRow).toBeGreaterThan(0);
		expect(previewRow).toBeLessThan(bottomBorder);
	});
});
