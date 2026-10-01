import { beforeAll, describe, expect, it } from "bun:test";
import { framedToolCard } from "@oh-my-pi/pi-tui/render/tool-card";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-tui/theme";

// Both cache layers (ToolCard's reusable options and CachedOutputBlock's hash) must see the stage
// tones. If they did not, a running -> error change with identical lines and label would be served
// the rows coloured for running. The oracle is raw ANSI, never stripped.

let theme: Theme;

beforeAll(async () => {
	await initTheme();
	theme = (await getThemeByName("dark"))!;
});

const WIDTH = 50;
const COMMAND = ["$ echo hi"];
const OUTPUT = ["hi"];

function makeCard(getPhase: () => "running" | "success" | "error") {
	return framedToolCard(theme, () => ({
		header: "Bash",
		phase: getPhase(),
		stageTone: "success",
		sections: [{ content: COMMAND }, { label: "Output", content: OUTPUT }],
	}));
}

describe("ToolCard stage tones through the cache path", () => {
	it("re-colours the live stage when only the phase changes, and leaves the top stage bytes alone", () => {
		let phase: "running" | "success" | "error" = "running";
		const card = makeCard(() => phase);
		const running = [...card.render(WIDTH)];
		phase = "error";
		const error = [...card.render(WIDTH)];

		// header + command row: identical bytes
		expect(error.slice(0, 2)).toEqual(running.slice(0, 2));
		// output separator, output row and bottom edge: coloured for the new state
		expect(error.slice(2)).not.toEqual(running.slice(2));
	});

	it("serves identical bytes when nothing changed (the cache still works)", () => {
		const card = makeCard(() => "running");
		const first = card.render(WIDTH);
		expect(card.render(WIDTH)).toEqual(first);
	});

	it("re-colours the top stage when only the stage tone changes (neither cache layer may serve stale rows)", () => {
		let stage: "success" | "error" = "success";
		const card = framedToolCard(theme, () => ({
			header: "Bash",
			phase: "running",
			stageTone: stage,
			sections: [{ content: COMMAND }, { label: "Output", content: OUTPUT }],
		}));
		const calm = [...card.render(WIDTH)];
		stage = "error";
		const loud = [...card.render(WIDTH)];
		expect(loud.slice(0, 2)).not.toEqual(calm.slice(0, 2));
		// the live stage follows `phase`, which did not change
		expect(loud.slice(2)).toEqual(calm.slice(2));
	});
});
