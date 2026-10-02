import { afterEach, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { VirtualTerminal } from "./virtual-terminal";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";

class FinalizingCard {
	finalized = false;
	readonly commitToHistoryOnFinalize = true;

	render(): readonly string[] {
		return Array.from({ length: 20 }, (_, index) => `FINALIZED_TOOL_CARD_${index}`);
	}

	isTranscriptBlockFinalized(): boolean {
		return this.finalized;
	}
}

/**
 * A card whose settled render differs from the rows it showed while running
 * (a pending "running" header that becomes "(13ms)", a tail-window marker that
 * disappears): the shape every real tool card takes at completion.
 */
class ReshapingCard {
	finalized = false;
	readonly commitToHistoryOnFinalize = true;

	render(): readonly string[] {
		const header = this.finalized ? "CARD · done (13ms)" : "CARD · running";
		return [header, ...Array.from({ length: 19 }, (_, index) => `CARD_ROW_${index}`)];
	}

	isTranscriptBlockFinalized(): boolean {
		return this.finalized;
	}
}

let composer: Composer | undefined;
afterEach(() => composer?.stop());

it("commits a tool card to native history on the first frame after it finalizes", async () => {
	const terminal = new VirtualTerminal(60, 14);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const card = new FinalizingCard();
	transcript.addChild(card);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start();
	composer.ui.setFocus(composer.editor);

	await terminal.waitForRender();
	composer.ui.requestRender();
	await terminal.waitForRender();
	expect(transcript.liveRowCount(60)).toBeGreaterThan(0);

	card.finalized = true;
	composer.ui.requestRender();
	await terminal.waitForRender();

	// The physical screen still shows the newest terminal-history tail above
	// the editor, but the TUI no longer owns a mutable live copy of the card.
	expect(transcript.liveRowCount(60)).toBe(0);
});

it("publishes a finalized result while the initial header and transcript still fit on screen", async () => {
	const terminal = new VirtualTerminal(80, 60);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const card = new FinalizingCard();
	transcript.addChild(card);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start({ playWelcomeIntro: false });
	await terminal.waitForRender();
	expect(transcript.liveRowCount(80)).toBe(20);
	card.finalized = true;
	composer.ui.requestRender();
	await terminal.waitForRender(() => transcript.liveRowCount(80) === 0);
	expect(transcript.liveRowCount(80)).toBe(0);
	expect(terminal.getScrollBuffer().flatMap(row => row.match(/FINALIZED_TOOL_CARD_\d+/g) ?? [])).toEqual(
		Array.from({ length: 20 }, (_, index) => `FINALIZED_TOOL_CARD_${index}`),
	);
});

it("retires the only completed foreground call without waiting for a later stream", async () => {
	const terminal = new VirtualTerminal(80, 60);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const card = new ToolExecutionComponent("custom-completion", {}, {}, undefined, composer.ui);
	transcript.addChild(card);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start({ playWelcomeIntro: false });
	card.updateResult({ content: [{ type: "text", text: "ONLY_FINISHED_RESULT" }] }, false);
	composer.ui.requestRender();
	await terminal.waitForRender(() => transcript.blockStates()[0] === "committed");
	expect(transcript.blockStates()).toEqual(["committed"]);
	expect(
		terminal
			.getScrollBuffer()
			.join("\n")
			.match(/ONLY_FINISHED_RESULT/g),
	).toHaveLength(1);
});

it("publishes completed grouped previews without overflow and commits the footer when the group finishes", async () => {
	const terminal = new VirtualTerminal(100, 100);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const group = new ReadToolGroupComponent({ showContentPreview: true });
	group.updateArgs({ path: "first.txt" }, "first");
	group.updateArgs({ path: "second.txt" }, "second");
	transcript.addChild(group);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start({ playWelcomeIntro: false });
	await terminal.waitForRender();
	group.updateResult({ content: [{ type: "text", text: "FIRST_COMPLETED_PREVIEW" }] }, false, "first");
	composer.ui.requestRender();
	await terminal.waitForRender(() => transcript.emittedStableRows()[0] === 1);
	expect(transcript.emittedStableRows()).toEqual([1]);
	expect(group.isTranscriptBlockFinalized()).toBeFalse();
	group.updateResult({ content: [{ type: "text", text: "SECOND_COMPLETED_PREVIEW" }] }, false, "second");
	group.attachUsage(
		["first", "second"],
		{
			input: 5,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		1000,
		500,
		new Date(2026, 9, 2, 23, 50, 54).getTime(),
	);
	group.finalize();
	composer.ui.requestRender();
	await terminal.waitForRender(() => transcript.blockStates()[0] === "committed");
	expect(transcript.blockStates()).toEqual(["committed"]);
	const tape = terminal
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row))
		.join("\n");
	expect(tape.match(/FIRST_COMPLETED_PREVIEW/g)).toHaveLength(1);
	expect(tape.match(/SECOND_COMPLETED_PREVIEW/g)).toHaveLength(1);
	expect(tape.indexOf("Read (2)")).toBeLessThan(tape.indexOf("2026-10-02 23:50:54"));
});

it("commits a finished edit while a second edit preview is still active without overflow", async () => {
	const terminal = new VirtualTerminal(100, 100);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const first = new ToolExecutionComponent(
		"edit",
		{ input: "[first.ts#1234]\nPUT 1.=1:\n+done" },
		{},
		undefined,
		composer.ui,
	);
	const second = new ToolExecutionComponent(
		"edit",
		{ input: "[second.ts#1234]\nPUT 1.=1:\n+pending" },
		{},
		undefined,
		composer.ui,
	);
	transcript.addChild(first);
	transcript.addChild(second);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start({ playWelcomeIntro: false });
	first.setArgsComplete();
	first.setExecutionStarted();
	second.setArgsComplete();
	second.setExecutionStarted();
	first.updateResult(
		{ content: [{ type: "text", text: "FINISHED_EDIT_ERROR: source anchor rejected" }], isError: true },
		false,
	);
	composer.ui.requestRender();
	await terminal.waitForRender(() => transcript.blockStates()[0] === "committed");
	expect(transcript.blockStates()).toEqual(["committed", "active"]);
	expect(second.isTranscriptBlockFinalized()).toBeFalse();
	expect(
		terminal
			.getScrollBuffer()
			.join("\n")
			.match(/FINISHED_EDIT_ERROR/g),
	).toHaveLength(1);
	second.seal();
});

it("never emits a card twice when its settled render diverges from rows the terminal already borrowed", async () => {
	const terminal = new VirtualTerminal(60, 14);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const card = new ReshapingCard();
	transcript.addChild(card);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start();
	composer.ui.setFocus(composer.editor);

	// Run tall enough for the terminal to borrow the card's head into scrollback.
	await terminal.waitForRender();
	composer.ui.requestRender();
	await terminal.waitForRender();
	composer.ui.requestRender();
	await terminal.waitForRender();

	card.finalized = true;
	composer.ui.requestRender();
	await terminal.waitForRender();
	composer.ui.requestRender();
	await terminal.waitForRender();

	const history = terminal.getScrollBuffer().join("\n");
	const firstRow = "CARD_ROW_0";
	const occurrences = history.split(firstRow).length - 1;
	expect(occurrences, `card body emitted ${occurrences} times:\n${history}`).toBe(1);
});
