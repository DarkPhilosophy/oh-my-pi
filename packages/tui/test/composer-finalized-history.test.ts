import { afterEach, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { VirtualTerminal } from "./virtual-terminal";

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
