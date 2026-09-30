import { afterEach, expect, it } from "bun:test";
import { KeybindingsManager as AppKeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { createPromptActionAutocompleteProvider } from "@oh-my-pi/pi-tui/prompt/prompt-action-autocomplete";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

let composer: Composer | undefined;
afterEach(() => composer?.stop());

const WIDTH = 120;

async function openComposer(options: { contextual: boolean; width?: number }): Promise<{
	terminal: VirtualTerminal;
	editor: Composer["editor"];
	paint: () => Promise<void>;
}> {
	const terminal = new VirtualTerminal(options.width ?? WIDTH, 16);
	const active = new Composer({ preferences: { quiet: true }, terminal });
	composer = active;
	const transcript = new TranscriptContainer();
	const block = {
		render: () => Array.from({ length: 30 }, (_, i) => `CHAT_${i + 1}`),
		isTranscriptBlockFinalized: () => true,
	};
	transcript.addChild(block);
	active.setRuntimeChildren([transcript, active.editor]);
	active.editor.commandSuggestionsPopup = true;
	active.editor.contextualTokenPopup = options.contextual;
	active.editor.onAutocompleteRender = (render, offset, rows, anchor) =>
		active.ui.setCursorOverlay(render, offset, rows, "auto", anchor);
	active.editor.setAutocompleteProvider(
		createPromptActionAutocompleteProvider({
			commands: [],
			basePath: "/tmp",
			keybindings: AppKeybindingsManager.inMemory({}),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		}),
	);
	active.editor.onAutocompleteUpdate = () => active.ui.requestRender();
	active.editor.onAutocompleteCancel = () => active.ui.requestRender();
	active.start();
	active.ui.setFocus(active.editor);
	const paint = async () => {
		// The composer settles on a real render timer; there is no event to await.
		await Bun.sleep(40);
		active.ui.requestRender();
		await terminal.waitForRender();
	};
	await paint();
	await paint();
	return { terminal, editor: active.editor, paint };
}

/** First viewport row containing `needle`, with the 0-based visible column where it starts. */
function locate(rows: readonly string[], needle: string): { row: number; col: number } | undefined {
	for (let row = 0; row < rows.length; row++) {
		const col = rows[row]!.indexOf(needle);
		if (col !== -1) return { row, col };
	}
	return undefined;
}

/** Last viewport row containing `needle`: the composer input sits below any popup that repeats the token. */
function locateLast(rows: readonly string[], needle: string): { row: number; col: number } | undefined {
	for (let row = rows.length - 1; row >= 0; row--) {
		const col = rows[row]!.lastIndexOf(needle);
		if (col !== -1) return { row, col };
	}
	return undefined;
}

/** Width of the contextual card for a `#N` token: cursor cell, frame and margin around the widest label. */
function cardWidth(token: string): number {
	return 6 + `Issue ${token}`.length;
}

it("starts the #N popup box exactly at the token column and leaves the chat text beside it", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true });
	const lead = "please review the pull request ";
	editor.handleInput(lead);
	for (const ch of "#12") editor.handleInput(ch);
	await paint();

	const rows = terminal.getViewport().map(Bun.stripANSI);
	const input = locate(rows, `${lead}#12`);
	const label = locate(rows, "PR #12");
	expect(input).toBeDefined();
	expect(label).toBeDefined();
	const tokenCol = input!.col + lead.length;

	// The box's left border sits on the token's column, above the input row.
	const boxRow = rows[label!.row]!;
	expect(label!.row).toBeLessThan(input!.row);
	expect(boxRow.indexOf("│")).toBe(tokenCol);
	// The chat text on that row is preserved to the left of the box.
	expect(boxRow.slice(0, tokenCol)).toMatch(/^CHAT_\d+\s*$/);
	// The card is as wide as its content, not a full-width band and not a fixed width.
	expect(boxRow.trimEnd().length).toBe(tokenCol + cardWidth("#12"));
});

it("follows the token when it moves right instead of staying at a fixed column", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true });
	editor.handleInput("see #3");
	await paint();
	const early = locate(terminal.getViewport().map(Bun.stripANSI), "PR #3");
	editor.setText("");
	editor.handleInput(`${"words ".repeat(8)}#3`);
	await paint();
	const late = locate(terminal.getViewport().map(Bun.stripANSI), "PR #3");

	expect(early).toBeDefined();
	expect(late).toBeDefined();
	// The anchor is derived from the typed token position, so a later token yields a later box.
	expect(late!.col).toBeGreaterThan(early!.col);
});

it("pulls the box left of a token near the right edge so the whole card stays on screen", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true });
	editor.handleInput(`${"x".repeat(WIDTH - 12)} #7`);
	await paint();

	const rows = terminal.getViewport().map(Bun.stripANSI);
	const input = locateLast(rows, "#7");
	const label = locate(rows, "PR #7");
	expect(input).toBeDefined();
	expect(label).toBeDefined();
	const boxRow = rows[label!.row]!;
	expect(label!.row).toBeLessThan(input!.row);
	// Clamped to the last column that still fits the card: its right border is the terminal's last cell.
	expect(boxRow.indexOf("│")).toBe(WIDTH - cardWidth("#7"));
	expect(boxRow.trimEnd().length).toBe(WIDTH);
});

it("anchors to the token's own column when the text wrapped onto a second row", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true });
	// Enough words to fill the first row so the sentence wraps; the short tail puts `#12` early on the
	// wrapped row, left of the column where the right-edge clamp would take over.
	const words = Array.from({ length: 22 }, (_, i) => `word${i}`).join(" ");
	editor.handleInput(`${words} see #12`);
	await paint();

	const rows = terminal.getViewport().map(Bun.stripANSI);
	const input = locateLast(rows, "#12");
	const label = locate(rows, "PR #12");
	expect(input).toBeDefined();
	expect(label).toBeDefined();
	// The token really is on a wrapped row, not on the row the sentence began on.
	const firstRow = locate(rows, "word0");
	expect(firstRow).toBeDefined();
	expect(input!.row).toBeGreaterThan(firstRow!.row);
	// The box opens above the input at the wrapped token's own column, not at the column-0 fallback.
	expect(label!.row).toBeLessThan(input!.row);
	expect(rows[label!.row]!.indexOf("│")).toBe(input!.col);
});

it("keeps the existing #N list under the editor when the setting is off", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: false });
	editor.handleInput("see ");
	for (const ch of "#12") editor.handleInput(ch);
	await paint();

	const rows = terminal.getViewport().map(Bun.stripANSI);
	const input = locate(rows, "see #12");
	const label = locate(rows, "PR #12");
	expect(input).toBeDefined();
	expect(label).toBeDefined();
	expect(label!.row).toBeGreaterThan(input!.row);
});

it("sizes the card to its content: tiny for #1, wider only when the number is long", async () => {
	const widthOf = async (typed: string, token: string): Promise<number> => {
		const { terminal, editor, paint } = await openComposer({ contextual: true });
		editor.handleInput(typed);
		await paint();
		const rows = terminal.getViewport().map(Bun.stripANSI);
		const label = locate(rows, `PR ${token}`);
		expect(label).toBeDefined();
		const boxRow = rows[label!.row]!;
		return boxRow.trimEnd().length - boxRow.indexOf("│");
	};
	const short = await widthOf("see #1", "#1");
	const long = await widthOf("see #123456789012345", "#123456789012345");

	// No blank padding for a short reference: the card is exactly as wide as its widest label.
	expect(short).toBe(cardWidth("#1"));
	// A long reference is a reason for a wider card, and it grows by exactly the extra digits.
	expect(long).toBe(cardWidth("#123456789012345"));
	expect(long - short).toBe("123456789012345".length - "1".length);
});

/** Rows of the viewport that still show a #12 suggestion. */
function suggestionRows(terminal: VirtualTerminal): string[] {
	return terminal
		.getViewport()
		.map(Bun.stripANSI)
		.filter(row => row.includes("PR #12") || row.includes("Issue #12"));
}

it("dismisses the #N suggestions when the draft is cleared, as Ctrl+C does", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: true });
	editor.handleInput("see ");
	for (const ch of "#12") editor.handleInput(ch);
	await paint();
	expect(suggestionRows(terminal).length).toBeGreaterThan(0);

	editor.clearDraft();
	await paint();

	// The buffer is empty, so no suggestion may survive on screen or in the editor's state.
	expect(editor.getText()).toBe("");
	expect(editor.isAutocompleteActive()).toBe(false);
	expect(suggestionRows(terminal)).toEqual([]);
});

it("dismisses the #N list below the editor when the draft is cleared with the popup setting off", async () => {
	const { terminal, editor, paint } = await openComposer({ contextual: false });
	editor.handleInput("see ");
	for (const ch of "#12") editor.handleInput(ch);
	await paint();
	expect(suggestionRows(terminal).length).toBeGreaterThan(0);

	editor.setText("");
	await paint();

	expect(editor.isAutocompleteActive()).toBe(false);
	expect(suggestionRows(terminal)).toEqual([]);
});
