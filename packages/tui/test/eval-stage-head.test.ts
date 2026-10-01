import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

// An eval cell has two stages: the code (final once its arguments are complete) and the execution
// (output, status events, display). For the code to be written to native history while the cell
// runs, its head and code rows must keep the same bytes in every later state; the run state and the
// duration belong to the Output separator below. Oracle is the RAW ANSI row: the old header changed
// colour, spinner glyph and width with the state.

const cards: ToolExecutionComponent[] = [];
const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
const WIDTH = 70;

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	for (const card of cards) card.stopAnimation();
	cards.length = 0;
});

function makeCard(): ToolExecutionComponent {
	const card = new ToolExecutionComponent(
		"eval",
		{ language: "js", title: "demo", code: "const STAGE_MARKER = 1;" },
		{},
		undefined,
		ui,
	);
	cards.push(card);
	card.setArgsComplete();
	return card;
}

function details(status: "running" | "complete" | "error", output: string) {
	return {
		cells: [
			{
				index: 0,
				language: "js",
				title: "demo",
				code: "const STAGE_MARKER = 1;",
				status,
				output,
				durationMs: status === "running" ? undefined : 1234,
			},
		],
	};
}

/** Rows from the top frame bar through the code row, raw. */
function codeStage(card: ToolExecutionComponent): string[] {
	const rows = [...card.render(WIDTH)];
	const code = rows.findIndex(row => Bun.stripANSI(row).includes("STAGE_MARKER"));
	expect(code).toBeGreaterThan(0);
	const first = rows.findIndex(row => Bun.stripANSI(row).trim() !== "");
	return rows.slice(first, code + 1);
}

const states: Array<[string, (card: ToolExecutionComponent) => void]> = [
	["pending", () => {}],
	[
		"running",
		card => {
			card.setExecutionStarted();
			card.updateResult(
				{ content: [{ type: "text", text: "partial" }], details: details("running", "partial") },
				true,
			);
		},
	],
	[
		"complete",
		card => {
			card.setExecutionStarted();
			card.updateResult({ content: [{ type: "text", text: "done" }], details: details("complete", "done") }, false);
		},
	],
	[
		"error",
		card => {
			card.setExecutionStarted();
			card.updateResult(
				{ content: [{ type: "text", text: "boom" }], details: details("error", "boom"), isError: true },
				false,
			);
		},
	],
];

describe("eval code stage is byte-identical in every state", () => {
	it("head and code rows are the same raw bytes for every state", () => {
		const reference = codeStage(makeCard());
		for (const [name, apply] of states) {
			const card = makeCard();
			apply(card);
			expect({ state: name, rows: codeStage(card) }).toEqual({ state: name, rows: reference });
		}
	});

	it("the head shows no state or duration; the Output separator carries them", () => {
		const text = (card: ToolExecutionComponent): string =>
			card
				.render(WIDTH)
				.map(row => Bun.stripANSI(row))
				.join("\n");
		const running = makeCard();
		states[1]![1](running);
		const complete = makeCard();
		states[2]![1](complete);
		expect(text(running)).toMatch(/Output.*Running/);
		expect(text(complete)).toMatch(/Output.*1\.2s/);
		const head = (card: ToolExecutionComponent): string =>
			Bun.stripANSI(card.render(WIDTH).find(row => Bun.stripANSI(row).includes("demo")) ?? "");
		expect(head(running)).not.toMatch(/running|1\.2s/);
		expect(head(complete)).not.toMatch(/running|1\.2s/);
	});

	it("a cell that is executing but has produced nothing yet already shows Running", () => {
		const card = makeCard();
		card.setExecutionStarted();
		const text = card
			.render(WIDTH)
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(text).toMatch(/Output.*Running/);
	});

	it("before execution starts there is no Output separator", () => {
		const text = makeCard()
			.render(WIDTH)
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(text).not.toMatch(/Output/);
	});
});

describe("eval lower stage shows it is working", () => {
	// Same contract as bash: the Output separator is the live row, it carries the loading glyph while the cell
	// runs (also before any output) and is a still row after the cell finished.
	const separator = (card: ToolExecutionComponent): string =>
		card
			.render(WIDTH)
			.map(row => Bun.stripANSI(row))
			.find(row => row.startsWith("├"))!;
	const frames = async (card: ToolExecutionComponent): Promise<number> => {
		const seen = new Set<string>();
		for (let i = 0; i < 8; i++) {
			seen.add(separator(card).trimEnd());
			await Bun.sleep(120);
		}
		return seen.size;
	};

	it("animates while executing, before any result", async () => {
		const card = makeCard();
		card.setExecutionStarted();
		expect(await frames(card)).toBeGreaterThan(1);
	});

	it("animates while running with an empty partial result", async () => {
		const card = makeCard();
		card.setExecutionStarted();
		card.updateResult({ content: [{ type: "text", text: "" }], details: details("running", "") }, true);
		expect(await frames(card)).toBeGreaterThan(1);
	});

	it("is a still row once the cell finished", async () => {
		const card = makeCard();
		card.setExecutionStarted();
		card.updateResult({ content: [{ type: "text", text: "ok" }], details: details("complete", "ok") }, false);
		const first = separator(card);
		await Bun.sleep(300);
		expect(separator(card)).toBe(first);
		expect(first).not.toContain("Running");
	});
});
