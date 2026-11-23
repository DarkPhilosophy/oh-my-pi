import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { setCopyUrlHandlerReady, setCopyUrlTargetProvider } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { RunTrace, Shell } from "@oh-my-pi/pi-natives";
import type { ShellTrace } from "@oh-my-pi/pi-wire";

// The command half keeps stable framing across execution states; the status
// lives on the Output separator below. Actual publication belongs to the
// transcript's upstream retirement protocol, not an implicit borrowed prefix.

const cards: ToolExecutionComponent[] = [];
const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
const WIDTH = 60;

beforeAll(async () => {
	await initTheme();
});

// Untraced fixtures: shell visualization draws a pending script preview that a
// traceless result never has; real bash results carry the trace.
beforeEach(() => {
	setChatTranscriptDisplayPreferences({ shellVisualization: false });
});

afterEach(() => {
	setChatTranscriptDisplayPreferences({ shellVisualization: true });
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

	it("uses the same themed frame for command and output without repainting the command rows", () => {
		const reference = commandStage(makeCard());
		const frameBg = theme.getBgAnsi("toolSuccessBg");
		expect(frameBg).not.toBe("");
		const frameFg = theme.fg("dim", "│").split("│")[0];
		for (const [name, apply] of states) {
			const card = makeCard();
			apply(card);
			expect({ state: name, rows: commandStage(card) }).toEqual({ state: name, rows: reference });
			for (const row of card.render(WIDTH)) {
				const corner = Bun.stripANSI(row)[0];
				if (corner && "╭│├╰".includes(corner)) {
					expect(row).toStartWith(frameBg + frameFg + corner);
				}
			}
		}
	});

	it("shows running and failure on the Output separator, not in the command header", () => {
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

	it("reports an async handoff as backgrounded, not as a finished command", () => {
		const card = makeCard();
		card.setExecutionStarted();
		card.updateResult(
			{ content: [], details: { async: { state: "running", jobId: "bg_test", type: "bash" } } },
			false,
		);
		const rendered = card.render(WIDTH);
		const rows = rendered.map(row => Bun.stripANSI(row));
		const separator = rows.find(row => row.includes("Output"))!;
		expect(separator).toMatch(/Output.*Backgrounded/);
		const commandEdge = rows.find(row => row.includes("STAGE_MARKER"))!.trimEnd().length - 1;
		expect(separator[commandEdge]).toBe("┴");
		expect(rows.some(row => row.includes("bg_test"))).toBe(true);
		const footer = rendered[rows.findIndex(row => row.includes("bg_test"))];
		expect(footer).toStartWith(theme.getBgAnsi("toolSuccessBg"));
		expect(commandStage(card)).toEqual(commandStage(makeCard()));
		expect(footer).toContain(theme.fg("dim", "╰───"));
	});

	it("copies the command from the Output separator and retained stdout from the bottom border", () => {
		const output = Array.from({ length: 40 }, (_, i) => `row\t${i}`).join("\n");
		const payloads: string[] = [];
		applyHyperlinkSetting("always");
		setCopyUrlTargetProvider(text => {
			payloads.push(text);
			return text === output ? "omp-copy:bash-test" : "omp-copy:bash-input";
		});
		setCopyUrlHandlerReady(true);
		try {
			const card = makeCard();
			card.setExecutionStarted();
			card.updateResult({ content: [{ type: "text", text: output }], details: { timeoutSeconds: 90 } }, false);
			const rows = card.render(80);
			const separator = rows.find(row => Bun.stripANSI(row).includes("Output"))!;
			expect(separator).toContain("omp-copy:bash-input");
			expect(Bun.stripANSI(separator).trimEnd()).toMatch(/\[copy input\]─[╮┤]$/);
			const footer = rows.findLast(row => Bun.stripANSI(row).trim().length > 0);
			expect(footer).not.toContain("omp-copy:bash-input");
			expect(footer).toContain("omp-copy:bash-test");
			expect(footer && Bun.stripANSI(footer).trimEnd()).toMatch(/^╰.*Timeout: 90s.*\[copy output\]─╯$/);
			expect(rows.filter(row => row.includes("omp-copy:"))).toEqual([separator, footer!]);
			expect(new Set(payloads)).toEqual(new Set(["echo STAGE_MARKER", output]));
			expect(rows.some(row => row.includes("row  0") || row.includes("row 0"))).toBe(false);
		} finally {
			setCopyUrlHandlerReady(false);
			setCopyUrlTargetProvider(undefined);
			applyHyperlinkSetting("auto");
		}
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

	it("keeps the whole card live, then publishes command and output in one framed batch", () => {
		const transcript = new TranscriptContainer();
		const card = makeCard();
		transcript.addChild(card);
		card.setExecutionStarted();
		card.updateResult({ content: [{ type: "text", text: "preview-output" }] }, true);
		expect(transcript.peekFinalizedBatch(WIDTH, 100)).toBeUndefined();
		const live = transcript.renderViewport(WIDTH, 100, { now: 0, tick: 0 }).map(row => Bun.stripANSI(row));
		expect(live.some(row => row.includes("STAGE_MARKER"))).toBe(true);
		expect(
			live.some(row => row.startsWith("│") && row.includes("preview-output") && row.trimEnd().endsWith("│")),
		).toBe(true);
		card.updateResult({ content: [{ type: "text", text: "final-output" }] }, false);
		const final = transcript.peekFinalizedBatch(WIDTH, 100)!;
		const rows = final.rows.map(row => Bun.stripANSI(row));
		const command = rows.findIndex(row => row.includes("STAGE_MARKER"));
		const divider = rows.findIndex(row => row.startsWith("├") && row.includes("Output"));
		const output = rows.findIndex(row => row.includes("final-output"));
		const footer = rows.findIndex(row => row.startsWith("╰"));
		expect(command).toBeGreaterThanOrEqual(0);
		expect(divider).toBeGreaterThan(command);
		expect(output).toBeGreaterThan(divider);
		expect(footer).toBeGreaterThan(output);
		expect(rows.join("\n")).not.toContain("preview-output");
		transcript.acknowledgeFinalizedBatch(final.id);
		expect(transcript.peekFinalizedBatch(WIDTH, 100)).toBeUndefined();
	});

	it("updates the interpreted command rows when a shell trace arrives mid-call", async () => {
		setChatTranscriptDisplayPreferences({ shellVisualization: true });
		const command = "STAGE_MARKER=1; printf OUTPUT_LINE";
		const card = new ToolExecutionComponent("bash", { command }, {}, undefined, ui);
		cards.push(card);
		card.setArgsComplete();
		card.setExecutionStarted();
		const transcript = new TranscriptContainer();
		transcript.addChild(card);
		const render = () => transcript.renderViewport(WIDTH, 100, { now: 0, tick: 0 }).map(row => Bun.stripANSI(row));
		const call = render().find(row => row.includes("STAGE_MARKER"));
		expect(call).toContain("STAGE_MARKER");
		const pending = transcript.peekFinalizedBatch(WIDTH, 100);
		if (pending) transcript.acknowledgeFinalizedBatch(pending.id);

		const trace = new RunTrace(command);
		const result = await new Shell().run({ command, trace, timeoutMs: 5_000 });
		expect(result.exitCode).toBe(0);
		card.updateResult(
			{
				content: [{ type: "text", text: "OUTPUT_LINE" }],
				details: { trace: JSON.parse(trace.snapshot()) as ShellTrace },
			},
			true,
		);
		const rows = render();
		const divider = rows.findIndex(row => row.includes("Output") && row.startsWith("├"));
		expect(rows.slice(0, divider).some(row => row.includes("STAGE_MARKER") && row !== call)).toBe(true);
		expect(rows.slice(divider + 1).some(row => /^│\s+OUTPUT_LINE\s+│$/.test(row.trimEnd()))).toBe(true);
		expect(pending).toBeUndefined();
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
