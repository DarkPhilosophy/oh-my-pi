import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { EditorTopGap } from "@oh-my-pi/pi-tui/prompt/editor-top-gap";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { type Component, Container, getKeybindings, setKeybindings, Text } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { AskDialogComponent } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";

withoutTerminalMultiplexer();

const ROWS = 40;
const COLUMNS = 100;
const TRANSCRIPT_ROWS = 60;
const TRANSCRIPT_PREFIX = "Settled transcript row ";

/** A settled assistant turn carrying one text block, typed so schema drift fails at compile time. */
function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

/** Below-transcript chrome that inflates on demand, mimicking a confirmation dialog or a tall multi-line editor swapped in above the input. */
class InlineWidget implements Component {
	rows = 0;

	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, i) => `Live widget row ${i}`);
	}
}

/** A live card whose visible tail follows the allocator's current frame budget. */
class AllocationAwareTransientCard implements Component {
	#allocation = Number.MAX_SAFE_INTEGER;

	constructor(private readonly rows: readonly string[]) {}

	isTranscriptBlockFinalized(): boolean {
		return false;
	}

	isTranscriptBlockTransient(): boolean {
		return true;
	}

	setTranscriptAllocation(rows: number): void {
		this.#allocation = rows;
	}

	render(): readonly string[] {
		return this.rows.slice(-this.#allocation);
	}
}

/** A mutable streaming card whose body grows between paints. */
class GrowingMutableCard implements Component {
	rows: string[] = [];
	transient = true;

	isTranscriptBlockFinalized(): boolean {
		return false;
	}

	isTranscriptBlockTransient(): boolean {
		return this.transient;
	}

	render(): readonly string[] {
		return this.rows;
	}
}

interface Harness {
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	transcript: TranscriptContainer;
	widget: InlineWidget;
	/** Turn-scoped chrome between transcript and editor (loader, todo/subagent HUDs). */
	hud: InlineWidget;
	editor: Container;
}

function makeHarness(
	columns = COLUMNS,
	rows = ROWS,
	transcriptRows = TRANSCRIPT_ROWS,
	shellHistory: readonly string[] = [],
): Harness {
	const terminal = new VirtualTerminal(columns, rows);
	if (shellHistory.length > 0) terminal.write(`${shellHistory.join("\r\n")}${"\r\n".repeat(rows + 1)}`);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	for (let i = 0; i < transcriptRows; i++) {
		const row = i;
		transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${row}`] });
	}
	const hud = new InlineWidget();
	const editor = new Container();
	const widget = new InlineWidget();
	editor.addChild(widget);
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, hud, editor]);
	composer.start({ playWelcomeIntro: false });
	return { terminal, scheduler, composer, transcript, widget, hud, editor };
}

/** Settle, grow the inline chrome, settle, shrink it back, settle. */
async function cycleWidget(h: Harness): Promise<void> {
	await h.scheduler.settle(h.terminal);
	h.widget.rows = 24;
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
	h.widget.rows = 0;
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
}

function hasBracketedBlankRun(rows: readonly string[]): boolean {
	for (let index = 0; index < rows.length; index++) {
		if (rows[index] === "") continue;
		let end = index + 1;
		while (rows[end] === "") end++;
		if (end - index - 1 >= 2 && end < rows.length) return true;
	}
	return false;
}

function normalizedScrollBuffer(terminal: VirtualTerminal): string[] {
	return terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
}

async function driveStreamingAttachmentCycle(rows: number): Promise<void> {
	const terminal = new VirtualTerminal(COLUMNS, rows);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	for (let index = 0; index < rows * 3; index++) {
		transcript.addChild({ render: () => [`Committed history ${index}`] });
	}
	const card = new GrowingMutableCard();
	transcript.addChild(card);
	const attachment = new InlineWidget();
	const editor = new Container();
	editor.addChild(attachment);
	editor.addChild(composer.editor);
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, editor]);
	composer.start({ playWelcomeIntro: false });
	composer.editor.setText("EDITOR");

	try {
		const paint = async (): Promise<void> => {
			composer.ui.requestRender();
			await scheduler.settle(terminal);
			const viewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			const editorRow = viewport.findLastIndex(row => row.includes("EDITOR"));
			expect(editorRow).toBeGreaterThanOrEqual(0);
			expect(viewport.slice(editorRow + 1).every(row => row === "")).toBe(true);
			expect(hasBracketedBlankRun(normalizedScrollBuffer(terminal))).toBe(false);
		};

		await paint();
		for (let frame = 0; frame < 3; frame++) {
			card.rows.push(...Array.from({ length: 3 }, (_, row) => `WRITE frame ${frame} row ${row}`));
			await paint();
		}
		attachment.rows = Math.min(6, Math.max(3, Math.floor(rows / 5)));
		await paint();
		for (let frame = 3; frame < 6; frame++) {
			card.rows.push(...Array.from({ length: 3 }, (_, row) => `WRITE frame ${frame} row ${row}`));
			await paint();
		}
		attachment.rows = 0;
		card.rows.push(...Array.from({ length: 3 }, (_, row) => `WRITE submit row ${row}`));
		transcript.insertSettledBlock({ render: () => ["Committed on submit"] });
		await paint();
		for (let frame = 6; frame < 9; frame++) {
			card.rows.push(...Array.from({ length: 3 }, (_, row) => `WRITE frame ${frame} row ${row}`));
			transcript.insertSettledBlock({ render: () => [`Committed after submit ${frame}`] });
			await paint();
		}
	} finally {
		composer.stop();
	}
}

/**
 * Longest run of blank rows above the row containing `bottom`. Transcript
 * blocks are separated by one blank row, so a longer run is a band of rows no
 * frame can fill.
 */
function blankBand(terminal: VirtualTerminal, bottom = "EDITOR"): number {
	const view = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	let run = 0;
	let longest = 0;
	for (const row of view.slice(
		0,
		view.findIndex(line => line.includes(bottom)),
	)) {
		run = row === "" ? run + 1 : 0;
		longest = Math.max(longest, run);
	}
	return longest;
}

/** Stream a 110-paragraph answer one paragraph per frame, then finalize it. */
async function streamFinalizedAnswer(h: Harness): Promise<void> {
	const message = new AssistantMessageComponent();
	h.transcript.addChild(message);
	const reply = (text: string): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	});
	const lines = Array.from({ length: 110 }, (_, i) => `line${i}`);
	for (let n = 1; n <= lines.length; n++) {
		message.updateContent(reply(lines.slice(0, n).join("\n\n")), { transient: true });
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
	}
	message.updateContent(reply(lines.join("\n\n")));
	message.markTranscriptBlockFinalized();
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
}

beforeAll(async () => {
	await initTheme();
});

describe("composer inline shrink (#11007)", () => {
	it("keeps native history contiguous while a streaming write card outgrows an attached editor", async () => {
		await driveStreamingAttachmentCycle(100);
		await driveStreamingAttachmentCycle(30);
	});

	it("reserves a mutable transient card at this frame's allocation after its live budget shrinks", () => {
		const terminal = new VirtualTerminal(COLUMNS, ROWS);
		const composer = new Composer({
			terminal,
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		const card = new AllocationAwareTransientCard(Array.from({ length: ROWS * 2 }, (_, i) => `CARD ${i}`));
		const editor = new Container();
		const widget = new InlineWidget();
		transcript.addChild(card);
		editor.addChild(widget);
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, editor]);
		composer.start({ playWelcomeIntro: false });

		const tall = composer.renderFrame({ columns: COLUMNS, rows: ROWS });
		expect(tall.viewport.filter(row => row.includes("CARD"))).toHaveLength(ROWS - 1);

		widget.rows = 30;
		const short = composer.renderFrame({ columns: COLUMNS, rows: ROWS });
		const cardRows = short.viewport.filter(row => row.includes("CARD"));
		expect(cardRows).toHaveLength(ROWS - 31);
		// The prior 39-row allocation must not reserve rows the 9-row card no
		// longer occupies in this frame.
		expect(short.viewport).toHaveLength(cardRows.length + widget.rows + 1);
		composer.stop();
	});

	it("answers an ask at the reported 54x112 geometry without losing, duplicating or stranding rows", async () => {
		const h = makeHarness(112, 54);
		await h.scheduler.settle(h.terminal);
		let submitted = false;
		const dialog = new AskDialogComponent(
			[
				{
					id: "approve",
					question: "Approve this section and the complete design for writing the spec?",
					options: [{ label: "Approve" }, { label: "Revise" }],
				},
			],
			{
				onSubmit: () => {
					submitted = true;
					h.editor.clear();
					h.editor.addChild(new Text("EDITOR", 0, 0));
					h.composer.ui.requestRender();
				},
				onCancel: () => {},
				onPrompt: () => Promise.resolve(undefined),
			},
		);
		h.editor.clear();
		h.editor.addChild(dialog);
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const removedRows = dialog.render(112).length - 1;
		const visibleRows = (): number[] =>
			h.terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
				.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		dialog.handleInput("\r");
		await h.scheduler.settle(h.terminal);
		expect(submitted).toBe(true);
		expect(visibleRows()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(53 - removedRows);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		dialog.dispose();
		h.composer.stop();
	});

	it("leaves a short transcript top-anchored when an ask panel retires nothing", async () => {
		const h = makeHarness(COLUMNS, ROWS, 3);
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 6;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const row = (needle: string): number =>
			h.terminal.getViewport().findIndex(line => Bun.stripANSI(line).trimEnd().startsWith(needle));
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		expect(row("EDITOR")).toBeLessThan(ROWS - 1);
		h.composer.stop();
	});

	it("lets a reset to an empty transcript shrink in place instead of pinning to the bottom", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		// A new session: scrollback is cleared and nothing replays into it.
		h.composer.setRuntimeChildren([new TranscriptContainer(), h.hud, h.editor]);
		h.composer.ui.resetDisplay();
		await h.scheduler.settle(h.terminal);
		h.widget.rows = ROWS + 5;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 3;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(3);
		h.composer.stop();
	});

	it("shrinks in place after an ask closes below a response taller than the screen", async () => {
		const terminal = new VirtualTerminal(COLUMNS, ROWS);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			tuiOptions: { renderScheduler: scheduler },
			preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		});
		const transcript = new TranscriptContainer();
		// Displaced response rows enter native history; closing the panel must
		// not pull them back into the mutable viewport.
		transcript.addChild({ render: () => Array.from({ length: 80 }, (_, i) => `${TRANSCRIPT_PREFIX}${i}`) });
		transcript.addChild({ render: () => Array.from({ length: 11 }, (_, i) => `Tool row ${i}`) });
		const editor = new Container();
		editor.addChild(new Text("EDITOR", 0, 0));
		composer.setRuntimeChildren([transcript, editor]);
		composer.start({ playWelcomeIntro: false });
		await scheduler.settle(terminal);
		const dialog = new AskDialogComponent(
			[{ id: "q", question: "Is it good?", options: [{ label: "Yes" }, { label: "No" }] }],
			{
				onSubmit: () => {
					editor.clear();
					editor.addChild(new Text("EDITOR", 0, 0));
					composer.ui.requestRender();
				},
				onCancel: () => {},
				onPrompt: () => Promise.resolve(undefined),
			},
		);
		editor.clear();
		editor.addChild(dialog);
		composer.ui.requestRender();
		await scheduler.settle(terminal);
		const removedRows = dialog.render(COLUMNS).length - 1;
		dialog.handleInput("\r");
		await scheduler.settle(terminal);
		expect(terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1 - removedRows);
		expect(blankBand(terminal)).toBeLessThanOrEqual(1);
		const indices = terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: 80 }, (_, i) => i));
		dialog.dispose();
		composer.stop();
	});

	it("keeps displaced conversation in history when the editable ask is hidden", async () => {
		// The default app bindings (Alt+H hides a pending ask).
		const previous = getKeybindings();
		setKeybindings(KeybindingsManager.inMemory());
		try {
			const h = makeHarness();
			await h.scheduler.settle(h.terminal);
			const dialog = new AskDialogComponent(
				[
					{
						id: "q",
						question: "Is it good?",
						options: ["A", "B", "C", "D"].map(label => ({ label, description: `${label} described` })),
					},
				],
				{ onSubmit: () => {}, onCancel: () => {}, onPrompt: () => Promise.resolve(undefined) },
				{ tui: h.composer.ui },
			);
			h.editor.clear();
			h.editor.addChild(dialog);
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			const reachable = (): number[] =>
				h.terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trimEnd())
					.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
					.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
			const removedRows = dialog.render(COLUMNS).length - 1;
			// Hiding the pending question removes its space without replaying history.
			dialog.handleInput("\x1bh");
			await h.scheduler.settle(h.terminal);
			const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			expect(view[ROWS - 1 - removedRows]).toContain("Ask hidden");
			expect(blankBand(h.terminal, "Ask hidden")).toBeLessThanOrEqual(1);
			expect(reachable()).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
			// Showing it again covers them without writing anything twice.
			dialog.handleInput("\x1bh");
			await h.scheduler.settle(h.terminal);
			const shown = reachable();
			expect(new Set(shown).size).toBe(shown.length);
			dialog.dispose();
			h.composer.stop();
		} finally {
			setKeybindings(previous);
		}
	});

	it("removes transient chrome space instead of pinning the editor to the bottom", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		const before = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(before.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);

		await cycleWidget(h);

		const after = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		// The 24 temporary rows disappear; committed rows stay in native history.
		expect(after.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1 - 24);
		const lastContent = after.reduce((last, row, i) => (row.length > 0 ? i : last), -1);
		expect(lastContent).toBe(ROWS - 1 - 24);

		h.composer.stop();
	});

	it("retires transcript rows contiguously with no duplication or gaps across the grow/shrink cycle", async () => {
		const h = makeHarness();
		await cycleWidget(h);

		// Every transcript row appears exactly once (native scrollback + live grid),
		// in order — the shrink must not drop rows into a gap or duplicate them.
		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));

		h.composer.stop();
	});

	// Regression for the black band users saw between scrollback and the live
	// view. A contraction used to re-anchor the shorter frame at the bottom and
	// leave the vacated rows blank and resident above it; the next overflowing
	// paint then scrolled that band into native scrollback, where it is
	// permanent, one fresh band per contraction. Keeping the frame origin on
	// contraction removes the band at its source.
	it("does not scroll erase-manufactured blank runs into native history while live content contracts", async () => {
		const h = makeHarness();
		try {
			await h.scheduler.settle(h.terminal);
			for (let iteration = 0; iteration < 4; iteration++) {
				h.widget.rows = 24;
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
				h.widget.rows = 0;
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
				h.transcript.addChild({ render: () => [`Streamed transcript row ${iteration}`] });
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
			}

			const surface = h.terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
			expect(hasBracketedBlankRun(surface)).toBe(false);
		} finally {
			h.composer.stop();
		}
	});

	it("uses actual chrome capacity across a height resize while inline chrome is expanded", async () => {
		const shorter = ROWS - 10;
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// Resize while expanded: only currently available rows count as live capacity.
		h.widget.rows = 24;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		h.terminal.resize(COLUMNS, shorter);
		await h.scheduler.advance(h.terminal, 300);
		for (let frame = 0; frame < 5; frame++) {
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const after = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(after.findIndex(row => row.includes("EDITOR"))).toBe(shorter - 1 - 24);
		const lastContent = after.reduce((last, row, i) => (row.length > 0 ? i : last), -1);
		expect(lastContent).toBe(shorter - 1 - 24);

		h.composer.stop();
	});

	it("clips the live tail from the top instead of compacting it when the chrome grows a few rows", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// A persistent few-row growth (multi-line prompt, todo HUD, subagent badge)
		// lifts the chrome above the retirement baseline. The tail must scroll
		// off the top like native history would — not collapse into the
		// one-row-per-block emergency layout that drops every inter-block blank
		// and strands the freed rows below the editor.
		h.widget.rows = 3;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const editorRow = view.findIndex(row => row.includes("EDITOR"));
		expect(editorRow).toBe(ROWS - 1);
		const transcriptRows = view.slice(0, editorRow - 3);
		const separators = transcriptRows.filter(
			(row, i) => row === "" && transcriptRows[i - 1]?.startsWith(TRANSCRIPT_PREFIX),
		);
		expect(separators.length).toBeGreaterThan(0);
		expect(transcriptRows.at(-1)).toBe(`${TRANSCRIPT_PREFIX}${TRANSCRIPT_ROWS - 1}`);

		h.composer.stop();
	});

	it("removes turn-scoped chrome without bringing committed rows back", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		h.hud.rows = 6;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		// The turn ends: the temporary six-row HUD disappears in place.
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1 - 6);
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		h.composer.stop();
	});

	it("leaves no band inside a streamed answer when the working loader goes away", async () => {
		const h = makeHarness(COLUMNS, 30);
		await h.scheduler.settle(h.terminal);
		const message = new AssistantMessageComponent();
		h.transcript.addChild(message);
		h.hud.rows = 2; // the working loader, up for the whole turn
		let text = "";
		for (let p = 0; p < 12; p++) {
			const words = Array.from({ length: 25 + (p % 4) * 10 }, (_, w) => `p${p}w${w}`).join(" ");
			for (const chunk of [words.slice(0, words.length / 2), words]) {
				message.updateContent(reply(`${text}${chunk}`), { transient: true });
				h.composer.ui.requestRender();
				await h.scheduler.settle(h.terminal);
			}
			text += `${words}\n\n`;
		}
		message.updateContent(reply(text.trim()));
		message.markTranscriptBlockFinalized();
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		// Loader removal must not insert a blank band into the answer.
		expect(blankBand(h.terminal)).toBeLessThanOrEqual(1);
		const words = h.terminal
			.getScrollBuffer()
			.join(" ")
			.split(/\s+/)
			.map(word => Bun.stripANSI(word))
			.filter(word => /^p\d+w\d+$/.test(word));
		expect(new Set(words).size).toBe(words.length);
		expect(words.length).toBe(text.split(/\s+/).filter(Boolean).length);
		h.composer.stop();
	});

	for (const placement of ["above", "below"] as const) {
		it(`clears a settled extension widget ${placement} the editor without a seam band or erasing shell history`, async () => {
			const rows = 30;
			const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
			const h = makeHarness(COLUMNS, rows, 0, shell);
			const above = new Container();
			above.addChild(
				new EditorTopGap(
					() => false,
					() => "band",
				),
			);
			const below = new Container();
			const widget = new InlineWidget();
			const root = placement === "above" ? above : below;
			root.addChild(widget);
			h.composer.setRuntimeChildren([h.transcript, above, h.editor, below]);
			await h.scheduler.settle(h.terminal);
			widget.rows = 7;
			await streamFinalizedAnswer(h);
			await h.scheduler.advance(h.terminal, 300);
			const history = (): string[] =>
				h.terminal
					.getScrollBuffer()
					.map(row => Bun.stripANSI(row).trim())
					.filter(row => /^(shell|line|next)\d+$/.test(row));
			const expected = [...shell, ...Array.from({ length: 110 }, (_, i) => `line${i}`)];
			expect(history()).toEqual(expected);
			expect(
				h.terminal
					.getViewport()
					.map(row => Bun.stripANSI(row).trim())
					.filter(row => row.startsWith("Live widget row ")),
			).toEqual(Array.from({ length: 7 }, (_, i) => `Live widget row ${i}`));

			root.removeChild(widget);
			h.composer.ui.requestRender();
			await h.scheduler.advance(h.terminal, 300);
			const editorRow = h.terminal.getViewport().findIndex(row => row.includes("EDITOR"));
			expect(editorRow).toBeLessThan(rows - 1);
			expect(editorRow).toBeGreaterThanOrEqual(0);
			expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
			expect(history()).toEqual(expected);
			for (let frame = 0; frame < 3; frame++) {
				h.composer.ui.requestRender();
				await h.scheduler.advance(h.terminal, 300);
				expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(editorRow);
				expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
				expect(history()).toEqual(expected);
			}

			// New output naturally fills the freed rows and restores bottom alignment.
			const next = Array.from({ length: 40 }, (_, i) => `next${i}`);
			for (const row of next) h.transcript.addChild({ render: () => [row] });
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			await h.scheduler.advance(h.terminal, 300);
			expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(rows - 1);
			expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
			expect(history()).toEqual([...expected, ...next]);
			h.composer.stop();
		});

		for (const timing of ["before settlement", "after settlement"] as const) {
			it(`preserves every transcript and shell row when an extension widget ${placement} the editor appears ${timing}`, async () => {
				const rows = 30;
				const shell = Array.from({ length: 12 }, (_, i) => `shell${i}`);
				const h = makeHarness(COLUMNS, rows, 0, shell);
				const persistent = new InlineWidget();
				const above = new Container();
				above.addChild(
					new EditorTopGap(
						() => false,
						() => "band",
					),
				);
				const below = new Container();
				const root = placement === "above" ? above : below;
				h.composer.setRuntimeChildren([h.transcript, persistent, above, h.editor, below]);
				try {
					await h.scheduler.settle(h.terminal);
					persistent.rows = 3;
					await streamFinalizedAnswer(h);
					await h.scheduler.settle(h.terminal);
					if (timing === "after settlement") await h.scheduler.advance(h.terminal, 300);

					// Extension agent_end work can install chrome after the final busy
					// paint, including after the first idle height has already settled.
					const widget = new InlineWidget();
					widget.rows = 7;
					root.addChild(widget);
					h.composer.ui.requestRender();
					await h.scheduler.advance(h.terminal, 300);
					const history = (): string[] =>
						h.terminal
							.getScrollBuffer()
							.map(row => Bun.stripANSI(row).trim())
							.filter(row => /^(shell|line)\d+$/.test(row));
					const expected = [...shell, ...Array.from({ length: 110 }, (_, i) => `line${i}`)];
					expect(history()).toEqual(expected);
					expect(
						h.terminal
							.getViewport()
							.map(row => Bun.stripANSI(row).trim())
							.filter(row => row.startsWith("Live widget row ")),
					).toEqual([
						...Array.from({ length: 3 }, (_, i) => `Live widget row ${i}`),
						...Array.from({ length: 7 }, (_, i) => `Live widget row ${i}`),
					]);

					root.removeChild(widget);
					h.composer.ui.requestRender();
					await h.scheduler.advance(h.terminal, 300);
					const editorRow = h.terminal.getViewport().findIndex(row => row.includes("EDITOR"));
					expect(editorRow).toBeGreaterThanOrEqual(0);
					expect(editorRow).toBeLessThan(rows - 1);
					expect(blankBand(h.terminal)).toBeLessThanOrEqual(2);
					expect(history()).toEqual(expected);
					h.composer.ui.requestRender();
					await h.scheduler.advance(h.terminal, 300);
					expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(editorRow);
					expect(history()).toEqual(expected);
				} finally {
					h.composer.stop();
				}
			});
		}
	}

	it("shrinks in place when a live block collapses under retired history", async () => {
		const h = makeHarness();
		const transcript = new TranscriptContainer();
		for (let i = 0; i < TRANSCRIPT_ROWS; i++) transcript.addChild({ render: () => [`${TRANSCRIPT_PREFIX}${i}`] });
		// A streaming tool preview that collapses to its short result.
		let toolRows = 12;
		transcript.addChild({ render: () => Array.from({ length: toolRows }, (_, i) => `Tool row ${i}`) });
		h.composer.setRuntimeChildren([transcript, h.hud, h.editor]);
		await h.scheduler.settle(h.terminal);
		toolRows = 4;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(view.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1 - (12 - 4));
		expect(view.filter(row => row.startsWith("Tool row "))).toHaveLength(4);
		h.composer.stop();
	});

	it("keeps settled transcript rows reachable while an inline ask panel is expanded (#12398)", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 24;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		// The ask panel can remain open indefinitely. Its growth must not hide
		// settled response rows from both the live screen and native scrollback.
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const after = h.terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
		expect(
			after.filter(row => row.startsWith(TRANSCRIPT_PREFIX)).map(row => Number(row.slice(TRANSCRIPT_PREFIX.length))),
		).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		const viewport = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const editorRow = viewport.findIndex(row => row.includes("EDITOR"));
		expect(viewport[editorRow - 1]).toBe(`${TRANSCRIPT_PREFIX}${TRANSCRIPT_ROWS - 1}`);
		expect(hasBracketedBlankRun(after)).toBe(false);
		h.composer.stop();
	});

	it("retires settled rows displaced by persistent chrome instead of hiding them until it shrinks", async () => {
		const h = makeHarness();
		await h.scheduler.settle(h.terminal);

		// A working loader + todo HUD stay up for a whole turn. Settled rows they
		// displace must reach native scrollback, not vanish between history and
		// the viewport until the turn ends.
		h.hud.rows = 4;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);

		const indices = h.terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row).trimEnd())
			.filter(row => row.startsWith(TRANSCRIPT_PREFIX))
			.map(row => Number(row.slice(TRANSCRIPT_PREFIX.length)));
		expect(indices).toEqual(Array.from({ length: TRANSCRIPT_ROWS }, (_, i) => i));
		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		expect(view.findIndex(row => row.includes("EDITOR"))).toBe(ROWS - 1);

		h.composer.stop();
	});

	it("leaves no filler around the reply when a block collapses", async () => {
		const rows = 50;
		const h = makeHarness(107, rows, 10);
		const card = new InlineWidget();
		card.rows = 25;
		h.transcript.addChild(card);
		const message = new AssistantMessageComponent();
		h.transcript.addChild(message);
		h.hud.rows = 2;
		await h.scheduler.settle(h.terminal);
		const table = [
			"| When | Where / unit | What he reports |",
			"|---|---|---|",
			`| 2024-08→ | **Kursk** | ${"Joined the Kursk counterattack after Ukraine's incursion; the unit retook territory; in Feb 2025 awarded a medal. ".repeat(3)} |`,
		].join("\n");
		const text = `**What the sources describe** — his own account, as printed in the interviews.\n\n${table}\n\n**Motivation.** Another paragraph of the reply, long enough to wrap at this width.\n`;
		for (let i = 1; i <= text.length; i += 24) {
			if (i / text.length > 0.7) card.rows = 1;
			message.updateContent(reply(text.slice(0, i)), { transient: true });
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
		}
		message.updateContent(reply(text));
		message.markTranscriptBlockFinalized();
		h.hud.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const bottom = view.findIndex(row => row.includes("└"));
		let run = 0;
		let longest = 0;
		for (const row of view.slice(0, bottom + 1)) {
			run = row === "" ? run + 1 : 0;
			longest = Math.max(longest, run);
		}
		// History and live answer remain contiguous; unused rows stay after the editor.
		expect(view[0]).not.toBe("");
		expect(longest).toBeLessThanOrEqual(1);
		const editorRow = view.findIndex(row => row.includes("EDITOR"));
		expect(editorRow).toBeGreaterThan(bottom);
		expect(editorRow).toBeLessThan(rows - 1);
		expect(view.slice(editorRow + 1).every(row => row === "")).toBe(true);
		h.composer.stop();
	});

	it("leaves a short transcript top-anchored after an inline panel closes", async () => {
		const h = makeHarness(COLUMNS, ROWS, 3);
		await h.scheduler.settle(h.terminal);
		h.widget.rows = 6;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		const row = (needle: string): number =>
			h.terminal.getViewport().findIndex(line => Bun.stripANSI(line).trimEnd().startsWith(needle));
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		h.widget.rows = 0;
		h.composer.ui.requestRender();
		await h.scheduler.settle(h.terminal);
		expect(row(`${TRANSCRIPT_PREFIX}0`)).toBe(0);
		expect(row("EDITOR")).toBeLessThan(ROWS - 1);
		h.composer.stop();
	});

	it("removes ten temporary rows from a full hundred-row screen without replay or lost messages", async () => {
		const h = makeHarness(COLUMNS, 100, 0);
		const messages = Array.from({ length: 99 }, (_, index) => `MESSAGE_${index}`);
		h.transcript.addChild(new Text(messages.join("\n"), 0, 0));
		const writes = spyOn(h.terminal, "write");
		try {
			await h.scheduler.settle(h.terminal);
			expect(h.terminal.getViewport().findIndex(row => row.includes("EDITOR"))).toBe(99);
			writes.mockClear();
			h.widget.rows = 10;
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			h.transcript.addChild(new Text("MESSAGE_99", 0, 0));
			messages.push("MESSAGE_99");
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			const reachable = () => normalizedScrollBuffer(h.terminal).filter(row => /^MESSAGE_\d+$/.test(row));
			expect(reachable()).toEqual(messages);
			h.widget.rows = 0;
			h.composer.ui.requestRender();
			await h.scheduler.settle(h.terminal);
			const view = h.terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			expect(view.findIndex(row => row === "EDITOR")).toBe(89);
			expect(view.slice(90)).toEqual(Array<string>(10).fill(""));
			expect(reachable()).toEqual(messages);
			expect(normalizedScrollBuffer(h.terminal).some(row => row.includes("Live widget"))).toBe(false);
			expect(writes.mock.calls.map(([data]) => data).join("")).not.toContain("\x1b[3J");
		} finally {
			writes.mockRestore();
			h.composer.stop();
		}
	});
});
