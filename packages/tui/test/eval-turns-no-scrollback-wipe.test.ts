import { afterEach, beforeAll, expect, it } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { createUsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import { VirtualTerminal } from "./virtual-terminal";

class CountingTerminal extends VirtualTerminal {
	writes = "";
	override write(data: string): void {
		this.writes += data;
		super.write(data);
	}
}

let composer: Composer | undefined;
const cards: ToolExecutionComponent[] = [];

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	for (const card of cards) card.stopAnimation();
	cards.length = 0;
	composer?.stop();
	composer = undefined;
});

function usage(input: number) {
	return {
		input,
		output: 92,
		cacheRead: 55_000,
		cacheWrite: 0,
		totalTokens: 55_092 + input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function details(code: string, output: string, status: "running" | "complete"): EvalToolDetails {
	return {
		cells: [
			{ index: 0, code, language: "python", output, status, durationMs: status === "complete" ? 2 : undefined },
		],
	};
}

// Each pending eval card expands the live region; when it retires, the expansion
// ends with no live row still lent to native history. Ending it must not clear
// scrollback (ESC[3J) and replay the whole transcript: that is a full-history
// flicker on every turn, and a duplicated history on terminals that keep
// scrollback across the clear.
for (const prefill of [0, 50]) {
	it(`runs eval turns without clearing scrollback (${prefill} history blocks above)`, async () => {
		const terminal = new CountingTerminal(140, 30);
		composer = new Composer({ preferences: { quiet: true }, terminal });
		const transcript = new TranscriptContainer();
		composer.setRuntimeChildren([transcript, composer.editor]);
		composer.start();
		composer.ui.setFocus(composer.editor);
		const frames = async (count = 3): Promise<void> => {
			for (let i = 0; i < count; i++) {
				composer!.ui.requestRender();
				await terminal.waitForRender();
			}
		};
		for (let k = 0; k < prefill; k++) transcript.addChild(new Text(`HISTORY_${k} filler paragraph`, 1, 0));
		await frames(4);
		const clearsBefore = terminal.writes.split("\x1b[3J").length - 1;

		const table = Array.from({ length: 20 }, (_, i) => `${i + 1} ${(i + 1) ** 2} ${(i + 1) ** 3}`).join("\n");
		const plan = [
			['print("E1:", 5 * 6)', "E1: 30"],
			["for i in range(1,21): print(i, i*i, i*i*i)", table],
			['print("E3:", 2 ** 16)', "E3: 65536"],
			['print("E4:", 7)', "E4: 7"],
		] as const;
		for (const [step, [code, output]] of plan.entries()) {
			const card = new ToolExecutionComponent(
				"eval",
				{ language: "python", code },
				{},
				undefined,
				composer.ui as unknown as TUI,
			);
			cards.push(card);
			transcript.addChild(card);
			await frames();
			card.setArgsComplete();
			transcript.addChild(createUsageRowBlock(usage(1000 + step), 5_800, undefined, Date.now()));
			await frames();
			card.setExecutionStarted();
			card.updateResult({ content: [{ type: "text", text: "" }], details: details(code, "", "running") }, true);
			await frames();
			card.updateResult(
				{ content: [{ type: "text", text: output }], details: details(code, output, "complete") },
				false,
			);
			await frames(4);
		}

		expect(terminal.writes.split("\x1b[3J").length - 1 - clearsBefore).toBe(0);
		const text = terminal.getScrollBuffer().join("\n");
		expect(text.split("E4: 7").length - 1).toBe(1);
		expect(text.split("20 400 8000").length - 1).toBe(1);
	});
}
