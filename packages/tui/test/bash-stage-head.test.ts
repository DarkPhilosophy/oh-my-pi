import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

// The command half of a bash card is final as soon as its arguments are complete. For it to be
// written to native history while the call runs, the head and command rows must have the same
// bytes in every later state; the status lives on the Output separator below. The oracle is the
// RAW ANSI row: colour is exactly what used to change.

const cards: ToolExecutionComponent[] = [];
const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
const WIDTH = 60;

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	for (const card of cards) card.stopAnimation();
	cards.length = 0;
});

function makeCard(): ToolExecutionComponent {
	const card = new ToolExecutionComponent("bash", { command: "echo STAGE_MARKER" }, {}, undefined, ui);
	cards.push(card);
	card.setArgsComplete();
	return card;
}

/** Rows from the top frame bar through the command row, raw. */
function commandStage(card: ToolExecutionComponent): string[] {
	const rows = [...card.render(WIDTH)];
	const command = rows.findIndex(row => Bun.stripANSI(row).includes("STAGE_MARKER"));
	expect(command).toBeGreaterThan(0);
	const first = rows.findIndex(row => Bun.stripANSI(row).trim() !== "");
	return rows.slice(first, command + 1);
}

describe("bash command stage is byte-identical in every state", () => {
	const states: Array<[string, (card: ToolExecutionComponent) => void]> = [
		["pending", () => {}],
		[
			"running",
			card => {
				card.setExecutionStarted();
				card.updateResult({ content: [{ type: "text", text: "partial" }] }, true);
			},
		],
		[
			"success",
			card => {
				card.setExecutionStarted();
				card.updateResult({ content: [{ type: "text", text: "done" }] }, false);
			},
		],
		[
			"error",
			card => {
				card.setExecutionStarted();
				card.updateResult({ content: [{ type: "text", text: "boom" }], isError: true }, false);
			},
		],
		[
			"timeout",
			card => {
				card.setExecutionStarted();
				card.updateResult(
					{ content: [{ type: "text", text: "slow" }], details: { timedOut: true }, isError: true },
					false,
				);
			},
		],
	];

	it("head and command rows are the same raw bytes for every state", () => {
		const reference = commandStage(makeCard());
		for (const [name, apply] of states) {
			const card = makeCard();
			apply(card);
			expect({ state: name, rows: commandStage(card) }).toEqual({ state: name, rows: reference });
		}
	});

	it("the status shows on the Output separator while the head stays plain", () => {
		const running = makeCard();
		states[1]![1](running);
		const failed = makeCard();
		states[3]![1](failed);
		const text = (card: ToolExecutionComponent): string =>
			card
				.render(WIDTH)
				.map(row => Bun.stripANSI(row))
				.join("\n");
		expect(text(running)).toMatch(/Output.*Running/);
		expect(text(failed)).toMatch(/Output.*failed/);
		expect(text(running)).not.toMatch(/Bash.*Running/);
	});

	it("a call that is executing but has no output yet already shows its Running state", () => {
		// The window between execution start and the first output chunk (a `sleep`) used to be
		// indistinguishable from a finished card once the status left the head.
		const card = makeCard();
		card.setExecutionStarted();
		const text = card
			.render(WIDTH)
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(text).toMatch(/Output.*Running/);
	});

	it("showing that state does not move the head or command rows", () => {
		const pending = makeCard();
		const executing = makeCard();
		executing.setExecutionStarted();
		expect(commandStage(executing)).toEqual(commandStage(pending));
	});

	it("before execution starts there is no Output separator yet", () => {
		const text = makeCard()
			.render(WIDTH)
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(text).not.toMatch(/Output/);
	});

	it("the lower box never gets narrower while output streams, even after a wide line leaves the window", () => {
		// A wide line enters the collapsed tail window and scrolls out again; if the box followed the visible
		// lines it would shrink and every right border would jump.
		const card = makeCard();
		card.setExecutionStarted();
		const lines: string[] = [];
		const widths: number[] = [];
		for (let i = 1; i <= 40; i++) {
			lines.push(i === 5 ? `wide-${"w".repeat(50)}` : `line-${i}`);
			card.updateResult({ content: [{ type: "text", text: lines.join("\n") }] }, true);
			const rows = card.render(120).map(row => Bun.stripANSI(row));
			const lower = rows.filter(row => /^(├|│|╰)/.test(row) && !row.includes("STAGE_MARKER"));
			widths.push(Math.max(...lower.map(row => [...row.trimEnd()].length)));
		}
		const shrinks = widths.flatMap((w, i) =>
			i > 0 && w < widths[i - 1]! ? [{ frame: i + 1, from: widths[i - 1], to: w }] : [],
		);
		expect(shrinks).toEqual([]);
	});
});

describe("bash card before execution starts has no lower stage and closes at its own width", () => {
	// Between "arguments complete" and "execution started" there is no Output section yet. The only
	// bottom border must then close the command box at the box's width; a bottom sized for the
	// (absent) lower stage is a few columns wide and reads as a broken corner under a wide box.
	const widthOf = (row: string): number => [...Bun.stripANSI(row).trimEnd()].length;
	const visibleRows = (card: ToolExecutionComponent): string[] =>
		card
			.render(WIDTH)
			.filter(row => Bun.stripANSI(row).trim() !== "")
			.map(row => Bun.stripANSI(row).trimEnd());

	it("arguments complete, not started: bottom border is as wide as the top border", () => {
		const rows = visibleRows(makeCard());
		expect(rows.at(-1)).toMatch(/^╰─+╯$/);
		expect(widthOf(rows.at(-1)!)).toBe(widthOf(rows[0]!));
	});

	it("a long command still closes at the box width, not at the corner width", () => {
		const card = new ToolExecutionComponent("bash", { command: `echo ${"x".repeat(200)}` }, {}, undefined, ui);
		cards.push(card);
		card.setArgsComplete();
		const rows = visibleRows(card);
		expect(widthOf(rows.at(-1)!)).toBe(widthOf(rows[0]!));
		expect(widthOf(rows[0]!)).toBeGreaterThan(20);
	});

	it("no phase offers the closing border to history: only the command rows are committed", () => {
		// The pending bottom is a placeholder close for the command box. Writing it to scrollback would leave
		// a `╰───╯` above the Output separator that is drawn once execution starts.
		const card = makeCard();
		expect(card.getTranscriptBlockSettledRows(WIDTH)).toBe(0);
		card.setExecutionStarted();
		card.updateResult({ content: [{ type: "text", text: "o1" }] }, true);
		card.render(WIDTH);
		const settled = card.getTranscriptBlockSettledRows(WIDTH);
		expect(settled).toBeGreaterThan(0);
		const committed = card
			.render(WIDTH)
			.slice(0, settled)
			.map(row => Bun.stripANSI(row));
		expect(committed.some(row => row.startsWith("╰"))).toBe(false);
		expect(committed.at(-1)).toContain("STAGE_MARKER");
	});

	it("while the arguments are still forming the box is closed at its own width too", () => {
		const card = new ToolExecutionComponent("bash", { command: "" }, {}, undefined, ui);
		cards.push(card);
		for (let n = 1; n <= 12; n++) {
			card.updateArgs({ command: Array.from({ length: n }, (_, i) => `echo step-${i}`).join("\n") });
			const rows = visibleRows(card);
			expect(widthOf(rows.at(-1)!)).toBe(widthOf(rows[0]!));
		}
	});
});

describe("bash lower stage shows it is working", () => {
	// With no output yet the lower box has no rows. The Output separator is the one live row, so it carries the
	// loading glyph; it must advance with the shared spinner and be a still row once the call finished.
	const separator = (card: ToolExecutionComponent): string =>
		card
			.render(WIDTH)
			.map(row => Bun.stripANSI(row))
			.find(row => row.startsWith("├"))!;
	const runningNoOutput = (): ToolExecutionComponent => {
		const card = makeCard();
		card.setExecutionStarted();
		card.updateResult({ content: [{ type: "text", text: "" }] }, true);
		return card;
	};

	it("the separator row changes between spinner frames while running with no output", async () => {
		const card = runningNoOutput();
		const seen = new Set<string>();
		for (let i = 0; i < 8; i++) {
			seen.add(separator(card).trimEnd());
			await Bun.sleep(120);
		}
		expect(seen.size).toBeGreaterThan(1);
	});

	it("keeps animating after output starts to stream", async () => {
		const card = runningNoOutput();
		card.updateResult({ content: [{ type: "text", text: "o1" }] }, true);
		const seen = new Set<string>();
		for (let i = 0; i < 8; i++) {
			seen.add(separator(card).trimEnd());
			await Bun.sleep(120);
		}
		expect(seen.size).toBeGreaterThan(1);
	});

	it("is a still row once the call has finished", async () => {
		const card = runningNoOutput();
		card.updateResult({ content: [{ type: "text", text: "done" }] }, false);
		const first = separator(card);
		await Bun.sleep(300);
		expect(separator(card)).toBe(first);
		expect(first).not.toContain("Running");
	});
});
