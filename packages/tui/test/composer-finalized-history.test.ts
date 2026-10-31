import { afterEach, expect, it } from "bun:test";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { VirtualTerminal } from "./virtual-terminal";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { QueuedMessageBox } from "@oh-my-pi/pi-tui/queued-message-box";

class FinalizingCard {
	finalized = false;

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

for (const quiet of [false, true]) {
	it(`keeps completed message bodies visible while restored history drains (quiet=${quiet})`, async () => {
		const terminal = new VirtualTerminal(80, 40);
		composer = new Composer({ preferences: { quiet }, terminal });
		const transcript = new TranscriptContainer();
		const blocks = Array.from({ length: 18 }, (_, index) => ({
			isTranscriptBlockFinalized: () => true,
			render: () => {
				const until = performance.now() + 4;
				while (performance.now() < until) {}
				return [`RESTORED_HEADER_${index}`, `RESTORED_BODY_${index}`, `RESTORED_END_${index}`];
			},
		}));
		for (const block of blocks) transcript.addChild(block);
		const viewports: string[][] = [];
		composer.ui.addPaintListener(paint => {
			viewports.push(paint.viewport.map(row => Bun.stripANSI(row).trimEnd()));
		});
		composer.setRuntimeChildren([transcript, new Text("RESTORED_CHROME", 0, 0)]);
		composer.start({ playWelcomeIntro: true });
		for (const rebuild of [false, true]) {
			if (rebuild) {
				viewports.length = 0;
				transcript.clear();
				for (const block of blocks) transcript.addChild(block);
				composer.ui.requestRender(true, { clearScrollback: true });
			}
			const drained = () => {
				const bodies = terminal.getScrollBuffer().flatMap(row => row.match(/RESTORED_BODY_\d+/g) ?? []);
				return viewports.length > 0 && bodies.length === 18;
			};
			// The real intro lasts three seconds; a single terminal wait is capped at two.
			for (let attempt = 0; attempt < 3 && !drained(); attempt++) await terminal.waitForRender(drained);
			for (const viewport of viewports) expect(viewport).toContain("RESTORED_BODY_17");
			expect(terminal.getScrollBuffer().flatMap(row => row.match(/RESTORED_BODY_\d+/g) ?? [])).toEqual(
				Array.from({ length: 18 }, (_, index) => `RESTORED_BODY_${index}`),
			);
		}
	}, 15_000);
}

it("keeps restored bodies readable when a running Bash survives a scrollback reset", async () => {
	const terminal = new VirtualTerminal(80, 24);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const blocks = Array.from({ length: 30 }, (_, index) => ({
		isTranscriptBlockFinalized: () => true,
		render: () => [`ACTIVE_HEADER_${index}`, `ACTIVE_BODY_${index}`, `ACTIVE_END_${index}`],
	}));
	const bash = new ToolExecutionComponent("bash", { command: "echo still-running" }, {}, undefined, composer.ui);
	bash.setArgsComplete();
	bash.setExecutionStarted();
	const paints: string[] = [];
	composer.ui.addPaintListener(() => paints.push(Bun.stripANSI(terminal.getViewport().join("\n"))));
	composer.setRuntimeChildren([transcript, new Text("ACTIVE_CHROME", 0, 0)]);
	try {
		for (const reset of [false, true]) {
			paints.length = 0;
			transcript.clear();
			for (const block of blocks) transcript.addChild(block);
			transcript.addChild(bash);
			if (reset) composer.ui.requestRender(true, { clearScrollback: true });
			else composer.start({ playWelcomeIntro: false });
			await terminal.waitForRender(() => paints.length > 0);
			expect(Bun.stripANSI(terminal.getViewport().join("\n"))).toContain("ACTIVE_BODY_29");
			for (const paint of paints) {
				expect(paint).toContain("ACTIVE_BODY_29");
				expect(paint).toContain("Bash");
			}
		}
	} finally {
		bash.stopAnimation();
	}
});

it("closes a long transcript without padding its final rows away from the shell", async () => {
	const terminal = new VirtualTerminal(120, 40);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const rows = Array.from({ length: 90 }, (_, index) => `EXIT_LINE_${index}`);
	transcript.addChild(new Text(rows.join("\n"), 0, 0));
	composer.setRuntimeChildren([transcript, new Text("EXIT_CHROME", 0, 0)]);
	composer.start({ playWelcomeIntro: false });
	await terminal.waitForRender();
	composer.ui.requestRender();
	await terminal.waitForRender();
	const before = terminal.getScrollBuffer().flatMap(row => row.match(/EXIT_LINE_\d+/g) ?? []);
	expect(before).toEqual(rows);
	composer.stop();
	terminal.write("SHELL");
	const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
	expect(buffer.flatMap(row => row.match(/EXIT_LINE_\d+/g) ?? [])).toEqual(rows);
	const tail = buffer.slice(buffer.indexOf("EXIT_LINE_89"), buffer.indexOf("SHELL") + 1);
	expect(tail).toEqual(["EXIT_LINE_89", "", "EXIT_CHROME", "SHELL"]);
});

it("keeps the live Bash footer after a queued steer squeezes its published command", async () => {
	const terminal = new VirtualTerminal(120, 40);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const queue = new Container();
	const todo = new Text(["TODO", ...Array.from({ length: 7 }, (_, i) => `TASK_${i}`)].join("\n"), 0, 0);
	transcript.addChild(new Text(Array.from({ length: 10 }, (_, i) => `BEFORE_STEER_${i}`).join("\n"), 0, 0));
	const bash = new ToolExecutionComponent(
		"bash",
		{ command: `python3 ${"nested/".repeat(25)}STEER_BASH_COMMAND` },
		{},
		undefined,
		composer.ui,
	);
	bash.setArgsComplete();
	bash.setExecutionStarted();
	const glob = new ToolExecutionComponent("glob", { pattern: "fixtures/**/*.rs" }, {}, undefined, composer.ui);
	glob.setArgsComplete();
	glob.setExecutionStarted();
	glob.updateResult(
		{ content: [{ type: "text", text: Array.from({ length: 25 }, (_, i) => `GLOB_ROW_${i}`).join("\n") }] },
		false,
	);
	const pending = new ReadToolGroupComponent({ showContentPreview: true });
	pending.updateArgs({ path: "next.rs" }, "next");
	transcript.addChild(bash);
	transcript.addChild(glob);
	transcript.addChild(pending);
	composer.setRuntimeChildren([transcript, queue, todo, composer.editor]);
	composer.start({ playWelcomeIntro: false });
	await terminal.waitForRender();
	composer.ui.requestRender();
	await terminal.waitForRender();
	try {
		queue.addChild(
			new QueuedMessageBox(
				"Steer",
				Array.from({ length: 14 }, (_, i) => `QUEUED_STEER_${i}`),
				{
					collapseLines: 30,
					expanded: true,
					footerText: "Alt+Up to edit",
				},
			),
		);
		composer.ui.requestRender();
		await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("QUEUED_STEER_13")));
		const buffer = terminal.getScrollBuffer().map(row => Bun.stripANSI(row).trimEnd());
		const bashStart = buffer.findIndex(row => row.includes("Bash"));
		const globStart = buffer.findIndex(row => /glob/i.test(row));
		const bashRows = buffer.slice(bashStart, globStart);
		expect(bashRows.some(row => row.includes("Running"))).toBe(true);
		expect(bashRows.some(row => row.startsWith("╰"))).toBe(true);
		expect(buffer.flatMap(row => row.match(/BEFORE_STEER_\d+/g) ?? [])).toEqual(
			Array.from({ length: 10 }, (_, i) => `BEFORE_STEER_${i}`),
		);
		expect(buffer.join("\n").match(/STEER_BASH_COMMAND/g)).toHaveLength(1);
		expect(bash.isTranscriptBlockFinalized()).toBe(false);
		queue.clear();
		bash.updateResult({ content: [{ type: "text", text: "BASH_AFTER_STEER_RESULT" }] }, false);
		pending.updateResult({ content: [{ type: "text", text: "READ_AFTER_STEER_RESULT" }] }, false, "next");
		pending.finalize();
		transcript.addChild(new Text("DELIVERED_STEER_MESSAGE", 0, 0));
		composer.ui.requestRender();
		await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("DELIVERED_STEER_MESSAGE")));
		const tape = terminal
			.getScrollBuffer()
			.map(row => Bun.stripANSI(row))
			.join("\n");
		expect(tape).not.toContain("QUEUED_STEER_");
		expect([...(tape.match(/BEFORE_STEER_\d+/g) ?? [])]).toEqual(
			Array.from({ length: 10 }, (_, i) => `BEFORE_STEER_${i}`),
		);
		for (const marker of [
			"STEER_BASH_COMMAND",
			"BASH_AFTER_STEER_RESULT",
			"READ_AFTER_STEER_RESULT",
			"DELIVERED_STEER_MESSAGE",
		]) {
			expect(tape.split(marker).length - 1).toBe(1);
		}
	} finally {
		bash.seal();
		pending.finalize();
	}
});

it("publishes only the offscreen portion of a finalized card and keeps its visible tail live", async () => {
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

	const visible = terminal.getViewport().flatMap(row => row.match(/FINALIZED_TOOL_CARD_\d+/g) ?? []);
	expect(visible.length).toBeGreaterThan(0);
	expect(visible.length).toBeLessThan(20);
	expect(transcript.liveRowCount(60)).toBe(visible.length);
	expect(terminal.getScrollBuffer().flatMap(row => row.match(/FINALIZED_TOOL_CARD_\d+/g) ?? [])).toEqual(
		Array.from({ length: 20 }, (_, index) => `FINALIZED_TOOL_CARD_${index}`),
	);
});

it("keeps an ordinary settled text block live until retirement pressure", async () => {
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
	await terminal.waitForRender();
	expect(transcript.liveRowCount(80)).toBe(20);
	expect(transcript.blockStates()).toEqual(["settled"]);
	transcript.addChild(new Text(Array.from({ length: 70 }, (_, index) => `LATER_CONTENT_${index}`).join("\n"), 0, 0));
	composer.ui.requestRender();
	await terminal.waitForRender(() => transcript.blockStates()[0] === "committed");
	expect(transcript.blockStates()[0]).toBe("committed");
	expect(terminal.getScrollBuffer().flatMap(row => row.match(/FINALIZED_TOOL_CARD_\d+/g) ?? [])).toEqual(
		Array.from({ length: 20 }, (_, index) => `FINALIZED_TOOL_CARD_${index}`),
	);
});

it("publishes the only completed foreground result without waiting for another stream", async () => {
	const terminal = new VirtualTerminal(80, 60);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const card = new ToolExecutionComponent("custom-completion", {}, {}, undefined, composer.ui);
	transcript.addChild(card);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start({ playWelcomeIntro: false });
	card.updateResult({ content: [{ type: "text", text: "ONLY_FINISHED_RESULT" }] }, false);
	composer.ui.requestRender();
	await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("ONLY_FINISHED_RESULT")));
	expect(transcript.blockStates()).toEqual(["committed"]);
	expect(
		terminal
			.getScrollBuffer()
			.join("\n")
			.match(/ONLY_FINISHED_RESULT/g),
	).toHaveLength(1);
});

it("shows completed grouped previews while later reads run and adds their final usage footer", async () => {
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
	await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("FIRST_COMPLETED_PREVIEW")));
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
	await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("SECOND_COMPLETED_PREVIEW")));
	expect(transcript.blockStates()).toEqual(["committed"]);
	const tape = terminal
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row))
		.join("\n");
	expect(tape.match(/FIRST_COMPLETED_PREVIEW/g)).toHaveLength(1);
	expect(tape.match(/SECOND_COMPLETED_PREVIEW/g)).toHaveLength(1);
	expect(tape.indexOf("Read (2)")).toBeLessThan(tape.indexOf("2026-10-02 23:50:54"));
});

it("shows a finished edit while a second edit preview is still active without overflow", async () => {
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
	await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("FINISHED_EDIT_ERROR")));
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

it("never duplicates a card when its finalized render differs from its live preview", async () => {
	const terminal = new VirtualTerminal(60, 14);
	composer = new Composer({ preferences: { quiet: true }, terminal });
	const transcript = new TranscriptContainer();
	const card = new ReshapingCard();
	transcript.addChild(card);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start();
	composer.ui.setFocus(composer.editor);

	// Paint the tall active preview before its final presentation becomes publishable.
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
