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

/** A settled card whose first row is on screen must show its bottom border before the next block. */
function cutCards(terminal: VirtualTerminal): string[] {
	const rows = terminal.getScrollBuffer().map(row => row.trimEnd());
	const cuts: string[] = [];
	let open = -1;
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index]!;
		if (row.includes("╭") && row.includes("ms)")) {
			if (open >= 0) cuts.push(rows.slice(open, index + 1).join("\n"));
			open = index;
		} else if (row.includes("╰") && open >= 0) {
			open = -1;
		} else if (row.includes("⤵") && open >= 0) {
			cuts.push(rows.slice(open, index + 1).join("\n"));
			open = -1;
		}
	}
	return cuts;
}

it("never paints a settled eval card without its tail when the next eval expands the live region", async () => {
	const terminal = new VirtualTerminal(100, 40);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start();
	composer.ui.setFocus(composer.editor);

	const cuts: string[] = [];
	const frames = async (count = 3): Promise<void> => {
		for (let i = 0; i < count; i++) {
			composer!.ui.requestRender();
			await terminal.waitForRender();
			cuts.push(...cutCards(terminal));
		}
	};

	// A session with history above: the screen is full before the evals start.
	for (let k = 0; k < 50; k++) transcript.addChild(new Text(`HISTORY_${k} filler paragraph`, 1, 0));
	await frames(4);
	expect(terminal.getScrollBuffer().length).toBeGreaterThan(40);

	const table = Array.from({ length: 20 }, (_, i) => `${String(i + 1).padStart(2)}: ${(i + 1) ** 2} ${(i + 1) ** 3}`);
	const plan = [
		['print("E1:", 5 * 6)', "E1: 30"],
		['for i in range(1, 21):\n    print(f"{i:>2}: {i*i:>4} {i*i*i:>6}")', table.join("\n")],
		['print("E3:", 2 ** 16)', "E3: 65536"],
		['print("E4:", 7)', "E4: 7"],
	] as const;
	for (const [step, [code, output]] of plan.entries()) {
		transcript.addChild(new Text(`thinking about step ${step + 1}`, 1, 0));
		await frames();
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
		// Real session order: the assistant message ends (usage row) while the
		// eval call is still pending; its result arrives afterwards.
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

	expect(cuts[0] ?? "", "a frame painted an eval card without its tail").toBe("");
	// The large card keeps its last output row and bottom border in the settled state as well.
	const text = terminal.getScrollBuffer().join("\n");
	expect(text.split("20: 400 8000").length - 1).toBe(1);
});
