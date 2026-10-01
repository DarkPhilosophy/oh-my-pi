import { beforeAll, describe, expect, it } from "bun:test";
import { renderOutputBlock } from "@oh-my-pi/pi-tui/render/output-block";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-tui/theme";

// A card whose top stage (header + command) is final while a lower stage (output) is still running
// must be able to freeze the top stage's bytes: its frame and background may not depend on the
// lower stage's state. Oracle is the RAW ANSI row, never `stripANSI` - colour is the whole point.

let theme: Theme;

beforeAll(async () => {
	await initTheme();
	theme = (await getThemeByName("dark"))!;
});

const WIDTH = 40;

function block(state: "running" | "success" | "error" | "warning", outputTone: boolean) {
	return renderOutputBlock(
		{
			header: "Bash",
			state,
			width: WIDTH,
			sections: [{ lines: ["$ echo hi"] }, { label: "Output", lines: ["hi"] }],
			// The command stage is neutral whatever the output stage is doing.
			stageTone: outputTone ? "success" : undefined,
		},
		theme,
	);
}

describe("renderOutputBlock stage tones", () => {
	it("top-stage rows are byte-identical across every output state when a stage tone is set", () => {
		const reference = block("success", true).slice(0, 2);
		for (const state of ["running", "error", "warning"] as const) {
			expect(block(state, true).slice(0, 2)).toEqual(reference);
		}
	});

	it("without a stage tone the top stage still follows the state (legacy cards unchanged)", () => {
		expect(block("running", false)[1]).not.toEqual(block("success", false)[1]);
	});

	it("the output stage carries its own state colour while the top stage stays neutral", () => {
		const running = block("running", true);
		const error = block("error", true);
		// separator + output row + bottom edge differ; the first two rows do not.
		expect(running.slice(2)).not.toEqual(error.slice(2));
	});

	it("top-stage rows keep their bytes, and output is not squeezed into the command's width, when the output gets wider", () => {
		const narrow = renderOutputBlock(
			{
				header: "demo",
				state: "running",
				width: 120,
				fitToContent: true,
				stageTone: "success",
				sections: [{ lines: ["const a = 1;"] }, { label: "Output", lines: ["ok"] }],
			},
			theme,
		);
		const wide = renderOutputBlock(
			{
				header: "demo",
				state: "error",
				width: 120,
				fitToContent: true,
				stageTone: "success",
				sections: [
					{ lines: ["const a = 1;"] },
					{ label: "Output · \u2718 1.2s", lines: ["a much longer output line than the command above"] },
				],
			},
			theme,
		);
		// Without a stage the second frame would be wider and the code row would gain padding.
		expect(wide.slice(0, 2)).toEqual(narrow.slice(0, 2));
		// ...and a wide output is wrapped at its own box, never squeezed into the command's narrow column.
		const outputRow = wide.find(row => Bun.stripANSI(row).includes("a much longer output line"))!;
		expect(Bun.stripANSI(outputRow).length).toBeGreaterThan(Bun.stripANSI(narrow[1]!).length);
	});
});
