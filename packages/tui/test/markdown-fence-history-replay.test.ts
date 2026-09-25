import { afterEach, beforeAll, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

class CountingTerminal extends VirtualTerminal {
	writes = "";
	override write(data: string): void {
		this.writes += data;
		super.write(data);
	}
}

let composer: Composer | undefined;
let message: AssistantMessageComponent | undefined;

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	composer?.stop();
	composer = undefined;
	message?.dispose();
	message = undefined;
});

function reply(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Streams `body` line by line past a 12-row screen, then finalizes; returns mid-session scrollback clears. */
async function streamPastViewport(open: string, close: string): Promise<{ clears: number; tape: string }> {
	const terminal = new CountingTerminal(60, 12);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	message = new AssistantMessageComponent(undefined, false);
	transcript.addChild(message);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start();
	composer.ui.renderNow();
	await terminal.waitForRender();
	const clearsBefore = terminal.writes.split("\x1b[3J").length - 1;

	let text = open;
	for (let index = 1; index <= 30; index++) {
		text += `MARKER_${String(index).padStart(2, "0")} ${"x".repeat(40)}\n`;
		message.updateContent(reply(text), { transient: true });
		composer.ui.renderNow();
	}
	text += close;
	message.updateContent(reply(text), { transient: true });
	composer.ui.renderNow();
	text += "\n\nFinished.";
	message.updateContent(reply(text), { transient: false });
	message.markTranscriptBlockFinalized();
	for (let i = 0; i < 4; i++) {
		composer.ui.renderNow();
		await terminal.waitForRender();
	}
	return {
		clears: terminal.writes.split("\x1b[3J").length - 1 - clearsBefore,
		tape: terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row))
			.join("\n"),
	};
}

// While a fence is open, its raw ``` delimiter and unframed body stream into
// native scrollback; when it closes, the finalized render frames the block.
// Scrollback cannot be edited in place, so that one block needs exactly one
// history rewrite. Plain streamed text never changes form and must not pay it.
it("rewrites history once when a streamed markdown fence closes into a frame", async () => {
	const { clears, tape } = await streamPastViewport("```text\n", "```");

	expect(tape).not.toContain("```text");
	const markers = Array.from(tape.match(/MARKER_\d{2}/g) ?? []);
	expect(markers).toEqual(Array.from({ length: 30 }, (_, i) => `MARKER_${String(i + 1).padStart(2, "0")}`));
	const framedRows = tape.split("\n").filter(row => /MARKER_\d{2}/.test(row) && row.includes("│"));
	expect(framedRows).toHaveLength(30);
	expect(clears).toBe(1);
});

it("does not rewrite history for plain streamed text that overflows the screen", async () => {
	const { clears, tape } = await streamPastViewport("", "");

	expect(Array.from(tape.match(/MARKER_\d{2}/g) ?? [])).toHaveLength(30);
	expect(clears).toBe(0);
});
