import { afterEach, expect, it } from "bun:test";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui";
import { encodeKittyPlacement } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { Composer } from "../src/modes/composer";
import { TranscriptContainer } from "../src/modes/components/transcript-container";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

let composer: Composer | undefined;
afterEach(() => composer?.stop());

it.each(["", "  "])("restores chat and history through popup filtering with prefix %j", async prefix => {
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
	composer.editor.handleInput(prefix);
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

it.each([false, true])("applies popup background only when fill is enabled (%s), retaining image data", async fill => {
	const terminal = new VirtualTerminal(40, 12);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const placement = encodeKittyPlacement({ imageId: 713, placementId: 713, columns: 40, rows: 8 });
	const image = { render: () => [...Array<string>(7).fill(""), "\x1b7\x1b[7A" + placement + "\x1b8"] };
	composer.setRuntimeChildren([image, composer.editor]);
	composer.editor.commandSuggestionsPopup = true;
	composer.editor.popupFill = fill;
	composer.editor.onAutocompleteRender = (render, offset, rows) => composer!.ui.setCursorOverlay(render, offset, rows);
	composer.editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider(Array.from({ length: 12 }, (_, i) => ({ name: `command${i}` }))),
	);
	composer.editor.onAutocompleteUpdate = () => composer!.ui.requestRender();
	composer.editor.onAutocompleteCancel = () => composer!.ui.requestRender();
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = data => {
		writes.push(data);
		write(data);
	};
	composer.start();
	composer.ui.setFocus(composer.editor);
	await terminal.waitForRender();
	expect(writes.join("")).toMatch(/\x1b_Ga=p,[^\x1b]*i=713,[^\x1b]*z=-2147483648\x1b\\/);
	writes.length = 0;
	composer.editor.handleInput("/");
	await Bun.sleep(40);
	composer.ui.requestRender();
	await terminal.waitForRender();
	expect(terminal.getViewport().join("\n")).toContain("command0");
	// Background styling is opt-in and must never delete transcript graphics.
	for (let row = 0; row < 8; row++) {
		if (fill)
			expect(terminal.getViewportRowBackgroundColumns(row)).toEqual(Array.from({ length: 40 }, (_, col) => col));
		else if (row === 0) expect(terminal.getViewportRowBackgroundColumns(row)).toEqual([]);
	}
	expect(writes.join("")).not.toMatch(/\x1b_Ga=d,/);
	writes.length = 0;
	composer.editor.handleInput("\x1b");
	composer.ui.requestRender();
	await terminal.waitForRender();
	expect(terminal.getViewport().join("\n")).not.toContain("command0");
	expect(writes.join("")).toMatch(/\x1b_Ga=p,[^\x1b]*i=713,/);
	expect(writes.join("")).not.toMatch(/\x1b_Ga=d,/);
});

it("keeps command arguments above the editor while filtering and accepting them", async () => {
	const terminal = new VirtualTerminal(44, 18);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const block = {
		render: () => Array.from({ length: 30 }, (_, i) => `CHAT_${i}`),
		isTranscriptBlockFinalized: () => true,
	};
	transcript.addChild(block);
	composer.setRuntimeChildren([transcript, composer.editor, { render: () => ["BELOW_EDITOR"] }]);
	composer.editor.commandSuggestionsPopup = true;
	composer.editor.onAutocompleteRender = (render, offset, rows) => composer!.ui.setCursorOverlay(render, offset, rows);
	composer.editor.setAutocompleteProvider(
		new CombinedAutocompleteProvider([
			{
				name: "advisor",
				getArgumentCompletions: prefix =>
					["on", "off", "status", "dump", "configure"]
						.filter(value => value.startsWith(prefix))
						.map(value => ({ value, label: value })),
			},
		]),
	);
	composer.editor.onAutocompleteUpdate = () => composer!.ui.requestRender();
	composer.editor.onAutocompleteCancel = () => composer!.ui.requestRender();
	composer.start();
	composer.ui.setFocus(composer.editor);
	const paint = async () => {
		await Bun.sleep(150);
		composer!.ui.requestRender();
		await terminal.waitForRender();
	};
	await paint();
	const history = terminal.getScrollBuffer().slice(0, -terminal.rows);
	for (const input of ["/advisor ", "o"]) {
		composer.editor.handleInput(input);
		await paint();
		const rows = terminal.getViewport().map(Bun.stripANSI);
		const editorRow = rows.findIndex(row => row.includes("/advisor"));
		const optionRow = rows.findIndex(row => /\boff\b/.test(row));
		expect(optionRow).toBeGreaterThanOrEqual(0);
		expect(optionRow).toBeLessThan(editorRow);
		expect(rows.findIndex(row => row.includes("BELOW_EDITOR"))).toBeGreaterThan(editorRow);
		expect(terminal.getScrollBuffer().slice(0, -terminal.rows)).toEqual(history);
	}
	composer.editor.handleInput("\t");
	await paint();
	expect(composer.editor.getText()).toBe("/advisor on");
	composer.editor.handleInput("\x1b");
	await paint();
	expect(terminal.getViewport().join("\n")).not.toMatch(/\boff\b/);
});
