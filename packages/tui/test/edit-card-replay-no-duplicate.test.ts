import { afterEach, beforeAll, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { createUsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

let composer: Composer | undefined;
let card: ToolExecutionComponent | undefined;

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	card?.stopAnimation();
	card = undefined;
	composer?.stop();
	composer = undefined;
});

function diffOf(lines: number): string {
	const out = ["@@ -300,5 +300,60 @@"];
	for (let i = 0; i < lines; i++) out.push(`+${300 + i}|    line ${i}`);
	return out.join("\n");
}

// A finished edit taller than the screen forces a scrollback replay while a
// history batch is still offered. The clear used to be consumed by that batch
// one frame early: it wiped history, wrote the stale screen (the card's
// streamed head) back, and the replay then landed below it without a clear,
// leaving a duplicated card head and an unpainted seam row inside the card.
it("replays a finished tall edit card without leaving a stale copy in scrollback", async () => {
	const terminal = new VirtualTerminal(156, 30);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start();
	const frames = async (count = 2): Promise<void> => {
		for (let i = 0; i < count; i++) {
			composer!.ui.requestRender();
			await terminal.waitForRender();
		}
	};
	for (let k = 0; k < 30; k++) transcript.addChild(new Text(`HISTORY_${k}`, 1, 0));
	await frames();

	card = new ToolExecutionComponent("edit", { path: "/tmp/a.tsx" }, {}, undefined, composer.ui as unknown as TUI);
	transcript.addChild(card);
	for (let lines = 1; lines <= 60; lines += 3) {
		card.updateArgs({ path: "/tmp/a.tsx", previewDiff: diffOf(lines) } as never);
		await frames(1);
	}
	card.setArgsComplete();
	transcript.addChild(
		createUsageRowBlock(
			{
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			} as never,
			5_000,
			undefined,
			Date.now(),
		),
	);
	await frames();
	card.setExecutionStarted();
	card.updateResult({ content: [{ type: "text", text: "ok" }], details: { diff: diffOf(60) } } as never, false);
	transcript.addChild(new Text("AFTER reply text", 1, 0));
	await frames(4);

	const text = terminal.getScrollBuffer().map(row => Bun.stripANSI(row));
	expect(text.filter(row => row.includes("+300│")).length).toBe(1);
	// History stays in order: every HISTORY row precedes the card.
	const cardTop = text.findIndex(row => row.includes("+300│"));
	expect(text.findIndex(row => row.trim() === "HISTORY_29")).toBeLessThan(cardTop);
});
