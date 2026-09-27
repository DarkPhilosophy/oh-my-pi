import { afterEach, beforeAll, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

class CountingTerminal extends VirtualTerminal {
	clears = 0;
	override write(data: string): void {
		this.clears += data.split("\x1b[3J").length - 1;
		super.write(data);
	}
}

let composer: Composer | undefined;
beforeAll(async () => {
	await initTheme();
});
afterEach(() => {
	composer?.stop();
	composer = undefined;
});

// One reply streams two writes; tools run only after the reply ends. The first
// card's head used to be neither on screen nor in history while the second
// streamed, appearing only once the reply finished.
it("sends the first write's scrolled-off rows to history while the second write streams", async () => {
	const terminal = new CountingTerminal(120, 30);
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
	for (let k = 0; k < 10; k++) transcript.addChild(new Text(`HISTORY_${k}`, 1, 0));
	await frames();
	const ui = composer.ui as unknown as TUI;
	const body = (tag: string, lines: number) => Array.from({ length: lines }, (_, i) => `${tag}_line_${i}`).join("\n");

	const first = new ToolExecutionComponent("write", { path: "/tmp/a.ts" }, {}, undefined, ui);
	transcript.addChild(first);
	for (let lines = 1; lines <= 20; lines += 4) {
		first.updateArgs({ path: "/tmp/a.ts", content: body("A", lines) } as never);
		await frames(1);
	}
	first.setArgsComplete();
	await frames();
	const second = new ToolExecutionComponent("write", { path: "/tmp/b.ts" }, {}, undefined, ui);
	transcript.addChild(second);
	for (let lines = 1; lines <= 40; lines += 4) {
		second.updateArgs({ path: "/tmp/b.ts", content: body("B", lines) } as never);
		await frames(1);
	}

	const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row));
	expect(buffer.filter(row => row.includes("/tmp/a.ts"))).toHaveLength(1);
	// The card's own preview window starts at line 8; every row of it is kept.
	for (let line = 8; line <= 16; line++) expect(buffer.some(row => row.includes(`A_line_${line}`))).toBe(true);
	// The settled preview was lent without a history rewrite.
	expect(terminal.clears).toBe(0);

	second.setArgsComplete();
	first.setExecutionStarted();
	first.updateResult({ content: [{ type: "text", text: "Wrote A" }] } as never, false);
	second.setExecutionStarted();
	second.updateResult({ content: [{ type: "text", text: "Wrote B" }] } as never, false);
	await frames(4);
	const final = terminal.getScrollBuffer().map(row => Bun.stripANSI(row));
	expect(final.filter(row => row.includes("/tmp/a.ts"))).toHaveLength(1);
	expect(final.filter(row => row.includes("/tmp/b.ts"))).toHaveLength(1);
	console.error("clears after results", terminal.clears);
});
