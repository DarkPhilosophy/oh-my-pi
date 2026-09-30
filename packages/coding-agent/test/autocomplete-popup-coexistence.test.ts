import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { createPromptActionAutocompleteProvider } from "@oh-my-pi/pi-tui/prompt/prompt-action-autocomplete";
import { VirtualRenderScheduler } from "../../tui/test/virtual-render-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

it.each([
	{ command: true, autocomplete: false },
	{ command: true, autocomplete: true },
	{ command: false, autocomplete: true },
])(
	"keeps contextual cards anchored and generic bands wide (command=$command, autocomplete=$autocomplete)",
	async ({ command, autocomplete }) => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "popup-coexistence-"));
		const terminal = new VirtualTerminal(120, 16);
		const scheduler = new VirtualRenderScheduler();
		const composer = new Composer({
			terminal,
			preferences: { quiet: true },
			tuiOptions: { renderScheduler: scheduler },
		});
		try {
			await fs.writeFile(path.join(directory, "candidate.txt"), "");
			const transcript = new TranscriptContainer();
			const block = {
				render: () => Array.from({ length: 30 }, (_, i) => `CHAT_${i}`),
				isTranscriptBlockFinalized: () => true,
			};
			transcript.addChild(block);
			composer.setRuntimeChildren([transcript, composer.editor]);
			composer.editor.commandSuggestionsPopup = command;
			composer.editor.autocompleteSuggestionsPopup = autocomplete;
			composer.editor.contextualTokenPopup = true;
			composer.editor.setAutocompleteProvider(
				createPromptActionAutocompleteProvider({
					commands: [],
					basePath: directory,
					keybindings: KeybindingsManager.inMemory({}),
					copyCurrentLine: () => {},
					copyPrompt: () => {},
					undo: () => {},
					moveCursorToMessageEnd: () => {},
					moveCursorToMessageStart: () => {},
					moveCursorToLineStart: () => {},
					moveCursorToLineEnd: () => {},
				}),
			);
			composer.editor.onAutocompleteUpdate = () => composer.ui.requestRender();
			composer.start();
			composer.ui.setFocus(composer.editor);
			await scheduler.settle(terminal);
			for (const [input, label, anchored] of autocomplete
				? ([
						["see #12", "PR #12", true],
						["@cand", "candidate.txt", false],
						[":smi", "smile", false],
					] as const)
				: ([["see #12", "PR #12", true]] as const)) {
				composer.editor.setText("");
				const updated = Promise.withResolvers<void>();
				composer.editor.onAutocompleteUpdate = () => {
					composer.ui.requestRender();
					updated.resolve();
				};
				for (const char of input) composer.editor.handleInput(char);
				await updated.promise;
				composer.ui.requestRender();
				await scheduler.settle(terminal);
				const rows = terminal.getViewport().map(Bun.stripANSI);
				const inputRow = rows.findLastIndex(row => row.includes(input));
				const labelRow = rows.findIndex(row => row.includes(label));
				expect(labelRow).toBeGreaterThanOrEqual(0);
				expect(labelRow).toBeLessThan(inputRow);
				const row = rows[labelRow]!;
				const tokenCol = rows[inputRow]!.indexOf(input) + 4;
				expect(row.indexOf("│")).toBe(anchored ? tokenCol : 0);
				// The anchored card is content-sized: compact `#12` is frame, inset, two cursor cells and the divider.
				expect(row.trimEnd().length).toBe(anchored ? tokenCol + 8 + "PR #12 | Issue #12".length : 120);
				if (anchored) expect(row.slice(0, tokenCol)).toMatch(/^CHAT/);
			}
		} finally {
			composer.stop();
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
);
