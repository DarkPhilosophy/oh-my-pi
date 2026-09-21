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
