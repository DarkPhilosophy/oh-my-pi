import { afterEach, expect, it } from "bun:test";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui";
import { Composer } from "../src/modes/composer";
import { TranscriptContainer } from "../src/modes/components/transcript-container";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

let composer: Composer | undefined;
afterEach(() => composer?.stop());

it("restores covered chat and preserves native history through filtering and dismissal", async () => {
	const terminal = new VirtualTerminal(60, 12);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const block = {
		render: () => Array.from({ length: 40 }, (_, i) => `CHAT_${i + 1}`),
		isTranscriptBlockFinalized: () => true,
	};
	transcript.addChild(block);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.editor.commandSuggestionsPopup = true;
	composer.editor.onAutocompleteRender = (render, offset, rows) => composer!.ui.setCursorOverlay(render, offset, rows);
	composer.editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider(Array.from({ length: 12 }, (_, i) => ({ name: `command${i}` }))),
	);
	composer.editor.onAutocompleteUpdate = () => composer!.ui.requestRender();
	composer.editor.onAutocompleteCancel = () => composer!.ui.requestRender();
	composer.start();
	composer.ui.setFocus(composer.editor);
	const paint = async () => {
		await Bun.sleep(40);
		composer!.ui.requestRender();
		await terminal.waitForRender();
	};
	await paint();
	await paint();
	const history = () => terminal.getScrollBuffer().slice(0, -terminal.rows);
	const beforeHistory = history();
	const before = terminal.getViewport().map(Bun.stripANSI);
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = data => {
		writes.push(data);
		write(data);
	};
	for (const input of ["/", "command1", "\x7f", "\x1b"]) {
		composer.editor.handleInput(input);
		await paint();
		expect(history()).toEqual(beforeHistory);
		if (input === "/") expect(terminal.getViewport().join("\n")).toContain("command0");
	}
	composer.editor.setText("");
	await paint();
	expect(terminal.getViewport().map(Bun.stripANSI)).toEqual(before);
	expect(writes.join("")).not.toMatch(/\x1b\[(?:2|3)J|\x1b\[\?1049h|\x1b\[\?1003h/);
});
