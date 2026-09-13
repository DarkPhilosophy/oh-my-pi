import { afterEach, expect, it, vi } from "bun:test";
import { CombinedAutocompleteProvider, Container, CURSOR_MARKER, Text } from "@oh-my-pi/pi-tui";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { Composer } from "../src/modes/composer";
import { ModelPickerComponent } from "../src/modes/components/model-picker";
import { TranscriptContainer } from "../src/modes/components/transcript-container";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

let composer: Composer | undefined;
afterEach(() => composer?.stop());

it("keeps the statusline, extension content and draft while searching and selecting inline", async () => {
	const terminal = new VirtualTerminal(100, 24);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const editor = composer.editor;
	editor.setText("draft to preserve");
	editor.setTopBorder({ content: "MODEL STATUS", width: 12 });
	const transcript = new TranscriptContainer();
	const block = {
		render: () => Array.from({ length: 40 }, (_, i) => `CHAT_${i}`),
		isTranscriptBlockFinalized: () => true,
	};
	transcript.addChild(block);
	const slot = new Container();
	slot.addChild(editor);
	composer.setRuntimeChildren([transcript, slot, new Text("EXTENSION BELOW INPUT", 0, 0)]);
	composer.start();
	composer.ui.setFocus(editor);
	const paint = async () => {
		await Bun.sleep(40);
		composer!.ui.requestRender();
		await terminal.waitForRender();
	};
	await paint();
	await paint();
	const history = terminal.getScrollBuffer().slice(0, -terminal.rows);
	const screen = terminal.getViewport().map(Bun.stripANSI);
	const models = ["alpha", "beta"].map(id =>
		buildModel({
			id,
			name: id,
			provider: "demo",
			api: "ollama-chat",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}),
	);
	const registry = {
		getAvailable: () => models,
		getAll: () => models,
		getError: () => undefined,
		refresh: async () => {},
	} as unknown as ModelRegistry;
	let selected: string | undefined;
	const close = () => {
		slot.removeChild(picker);
		slot.addChild(editor);
		composer!.ui.setFocus(editor);
	};
	const picker = new ModelPickerComponent(
		composer.ui,
		Settings.isolated(),
		registry,
		[],
		{
			onPick: (_model, id) => {
				selected = id;
				close();
			},
			onCancel: close,
		},
		{ editorRows: editor.render(100).length, renderEditorRows: width => editor.render(width, true) },
	);
	const writes: string[] = [];
	const write = terminal.write.bind(terminal);
	terminal.write = data => {
		writes.push(data);
		write(data);
	};
	slot.removeChild(editor);
	slot.addChild(picker);
	composer.ui.setFocus(picker);
	await paint();
	expect(terminal.getViewport().join("\n")).toContain("MODEL STATUS");
	expect(terminal.getViewport().at(-1)).toContain("EXTENSION BELOW INPUT");
	picker.handleInput("beta");
	await paint();
	expect(terminal.getScrollBuffer().slice(0, -terminal.rows)).toEqual(history);
	picker.handleInput("\r");
	await paint();
	expect(selected).toBe("demo/beta");
	expect(editor.getText()).toBe("draft to preserve");
	expect(terminal.getViewport().map(Bun.stripANSI)).toEqual(screen);
	expect(writes.join("")).not.toMatch(/\x1b\[(?:2|3)J|\x1b\[\?1049h|\x1b\[\?1003h/);
});

it.each(["box", "pi", "claude"])(
	"replaces completion rows without losing %s editor chrome or duplicating the cursor",
	async style => {
		const terminal = new VirtualTerminal(80, 16);
		composer = new Composer({ preferences: { quiet: true }, terminal });
		const editor = composer.editor;
		editor.setBorderStyle(style);
		const slot = new Container();
		slot.addChild(editor);
		const transcript = new TranscriptContainer();
		const block = {
			render: () => Array.from({ length: 30 }, (_, i) => `CHAT_${i}`),
			isTranscriptBlockFinalized: () => true,
		};
		transcript.addChild(block);
		composer.setRuntimeChildren([transcript, slot, new Text("EXTENSION BELOW INPUT", 0, 0)]);
		editor.setAutocompleteProvider(
			new CombinedAutocompleteProvider([{ name: "completion-only", description: "Completion description" }], "/tmp"),
		);
		const updated = Promise.withResolvers<void>();
		editor.onAutocompleteUpdate = updated.resolve;
		editor.handleInput("/");
		await updated.promise;
		expect(editor.render(80).join("\n")).toContain("completion-only");
		composer.start();
		composer.ui.setFocus(editor);
		await terminal.waitForRender();
		const showError = vi.fn();
		const controller = new SelectorController({
			ui: composer.ui,
			editor,
			editorContainer: slot,
			settings: Settings.isolated({ "display.inlineModelPicker": true }),
			session: {
				modelRegistry: {
					getAll: () => [],
					getAvailable: () => [],
					getError: () => undefined,
					refresh: async () => {},
				},
				scopedModels: [],
				getContextUsage: () => undefined,
				getRoleModelCycle: () => undefined,
			},
			keybindings: { getKeys: () => [], getDisplayString: () => "" },
			showError,
		} as unknown as InteractiveModeContext);
		controller.showModelSelector({ temporaryOnly: true });
		await terminal.waitForRender();
		const viewport = terminal.getViewport();
		expect(viewport.join("\n")).not.toContain("completion-only");
		const footerRow = viewport.findIndex(line => line.includes("EXTENSION BELOW INPUT"));
		expect(footerRow).toBeGreaterThan(0);
		const editorRows = editor.render(80, true);
		const inputRow = editorRows.findIndex(line => line.includes(CURSOR_MARKER));
		const screenInputRow = footerRow - editorRows.length + inputRow;
		expect(viewport[screenInputRow]).toContain("Search model");
		const picker = slot.children[0] as ModelPickerComponent;
		if (inputRow < editorRows.length - 1) expect(picker.render(80).at(-1)).toBe(editorRows.at(-1));
		composer.ui.setShowHardwareCursor(true);
		expect(picker.render(80)[inputRow]).not.toContain("\x1b[7m");
		composer.ui.setShowHardwareCursor(false);
		expect(picker.render(80)[inputRow]).toContain("\x1b[7m");
		picker.handleInput("\x1b");
		await terminal.waitForRender();
		expect(editor.getText()).toBe("/");
		expect(terminal.getViewport()[screenInputRow]).toContain("/");
		expect(showError).not.toHaveBeenCalled();
	},
);
