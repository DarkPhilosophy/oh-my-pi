import { beforeAll, describe, expect, it } from "bun:test";
import { createCustomMessage } from "@oh-my-pi/pi-agent-core/compaction/messages";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { messageBlock, PresentedBlock, setTranscriptPresenters } from "@oh-my-pi/pi-tui/chat/transcript-presentation";
import {
	type CompactTranscriptBlock,
	TranscriptContainer,
	trimBlankEdges,
} from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui";

beforeAll(async () => {
	await initTheme(false);
});

/** A finalized block whose compactness a test flips. */
class Block implements Component, CompactTranscriptBlock {
	compact: boolean;
	readonly #rows: (width: number) => readonly string[];

	constructor(rows: readonly string[] | ((width: number) => readonly string[]), compact: boolean) {
		this.#rows = typeof rows === "function" ? rows : () => rows;
		this.compact = compact;
	}

	isTranscriptBlockCompact(): boolean {
		return this.compact;
	}

	render(width: number): readonly string[] {
		return this.#rows(width);
	}
}

const compact = (...rows: string[]) => new Block(rows, true);
const plain = (...rows: string[]) => new Block(rows, false);

/** Greedy word wrap, so the same content takes a different row count at each width. */
function wrapWords(words: readonly string[], width: number): string[] {
	const rows: string[] = [];
	let row = "";
	for (const word of words) {
		if (row.length > 0 && row.length + 1 + word.length > width) {
			rows.push(row);
			row = word;
		} else {
			row = row.length > 0 ? `${row} ${word}` : word;
		}
	}
	if (row.length > 0) rows.push(row);
	return rows;
}

/**
 * A terminal: acknowledged retirement batches land in native history, the
 * live viewport below them. Each frame runs the way the composer runs it:
 * offer under pressure, render the viewport against that offer, acknowledge.
 */
class Screen {
	history: string[] = [];
	viewport: readonly string[] = [];
	#tick = 0;

	constructor(
		readonly transcript: TranscriptContainer,
		public width: number,
	) {}

	/** Everything the terminal shows, scrollback first. */
	get rows(): string[] {
		return [...this.history, ...this.viewport];
	}

	frame(room: number): boolean {
		const frame = { tick: this.#tick, now: this.#tick++ };
		this.transcript.beginFrame(frame);
		const batch = this.transcript.peekFinalizedBatch(this.width, room);
		this.viewport = this.transcript.renderViewport(this.width, room, frame);
		if (batch === undefined) return false;
		this.history.push(...batch.rows);
		this.transcript.acknowledgeFinalizedBatch(batch.id);
		return true;
	}

	/** Frames until nothing more retires. */
	settle(room: number): void {
		for (let frames = 0; this.frame(room); frames++) {
			if (frames > 100) throw new Error("retirement never settled");
		}
	}

	/** A scrollback-clearing replay of the committed ledger. */
	replay(): void {
		this.transcript.beginReplay();
		const batch = this.transcript.peekReplayBatch(this.width);
		this.history = batch ? [...batch.rows] : [];
		if (batch) this.transcript.acknowledgeFinalizedBatch(batch.id);
	}
}

const frame = { tick: 0, now: 0 };

/**
 * Compact one-row blocks around a non-compact note and a three-row compact
 * block, added one at a time to a four-row viewport, so retirement commits
 * compact runs whole and splits both multi-row blocks across the top edge.
 * Every frame must show exactly the transcript.
 */
function buildUnderPressure(): Screen {
	const transcript = new TranscriptContainer();
	const screen = new Screen(transcript, 40);
	const blocks = [
		compact("c0"),
		compact("c1"),
		compact("c2"),
		plain("note 1", "note 2", "note 3"),
		compact("c3"),
		compact("t1", "t2", "t3"),
		compact("c4"),
		compact("c5"),
		compact("c6"),
	];
	for (const block of blocks) {
		transcript.addChild(block);
		screen.settle(4);
		expect(screen.rows).toEqual([...transcript.render(40)]);
	}
	return screen;
}

describe("TranscriptContainer compact packing", () => {
	it("draws no separator between compact neighbors, across empty blocks, and one around other blocks", () => {
		const transcript = new TranscriptContainer();
		for (const block of [compact("c1"), compact("c2"), plain(), compact("c3"), plain("note"), compact("c4")]) {
			transcript.addChild(block);
		}
		const expected = ["c1", "c2", "c3", "", "note", "", "c4"];
		expect(transcript.renderViewport(40, 20, frame)).toEqual(expected);
		expect(transcript.render(40)).toEqual(expected);
		// The composer budgets the viewport by this count; a stale separator would misplace retirement.
		expect(transcript.liveRowCount(40)).toBe(expected.length);
	});

	it("packs extension messages whose renderer component reports compact rows", () => {
		const transcript = new TranscriptContainer();
		const message = (text: string) => createCustomMessage("probe", text, true, undefined, "2026-01-01");
		const renderer = (msg: { content: unknown }) => compact(String(msg.content));
		transcript.addChild(new CustomMessageComponent(message("one"), renderer));
		transcript.addChild(new CustomMessageComponent(message("two"), renderer));
		transcript.addChild(plain("note"));
		expect(transcript.render(40)).toEqual(["one", "two", "", "note"]);
	});

	it("packs blocks a transcript presenter compacts, and separates one the user expands", () => {
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		setTranscriptPresenters([() => "compact"]);
		const tools = ["one", "two", "three"].map((word, index) => {
			const tool = new ToolExecutionComponent("bash", { command: `echo ${word}` }, {}, undefined, ui);
			tool.setArgsComplete(`call-${index}`);
			tool.setExecutionStarted(`call-${index}`);
			tool.updateResult({ content: [{ type: "text", text: word }], isError: false });
			return tool;
		});
		const skill = new PresentedBlock(
			plain("skill body"),
			messageBlock(createCustomMessage("skill-prompt", "body", true, { name: "unslop" }, "2026-01-01")),
		);
		try {
			const transcript = new TranscriptContainer();
			transcript.addChild(tools[0]!);
			transcript.addChild(skill);
			transcript.addChild(tools[1]!);
			transcript.addChild(tools[2]!);
			const packed = transcript.render(80).map(row => Bun.stripANSI(row));
			expect(packed).toHaveLength(4);
			expect(packed[1]).toContain("unslop");

			// Ctrl+O on one call draws its full card, set apart from the compact rows around it.
			tools[1]!.setExpanded(true);
			const expanded = transcript.render(80).map(row => Bun.stripANSI(row));
			expect(expanded.length).toBeGreaterThan(6);
			expect(expanded[2]).toBe("");
			expect(expanded.at(-2)).toBe("");
			tools[1]!.setExpanded(false);

			// A wrapped block drawn in full packs only as its inner block does.
			skill.setExpanded(true);
			expect(
				transcript
					.render(80)
					.map(row => Bun.stripANSI(row))
					.slice(1, 5),
			).toEqual(["", "skill body", "", expect.stringContaining("echo two")]);
		} finally {
			setTranscriptPresenters([]);
			for (const tool of tools) tool.dispose();
			stopSharedSpinnerTicker();
		}
	});

	it("stacks edit and write cards from separate calls flush, and separates other tools", () => {
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const finished = (name: string, args: Record<string, unknown>, index: number) => {
			const tool = new ToolExecutionComponent(name, args, {}, undefined, ui);
			tool.setArgsComplete(`call-${index}`);
			tool.setExecutionStarted(`call-${index}`);
			tool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
			return tool;
		};
		const tools = [
			finished("write", { path: "a.txt", content: "alpha\nbeta\n" }, 0),
			finished("write", { path: "b.txt", content: "gamma\n" }, 1),
			finished("bash", { command: "echo done" }, 2),
			finished("write", { path: "c.txt", content: "delta\n" }, 3),
		];
		try {
			const transcript = new TranscriptContainer();
			for (const tool of tools) transcript.addChild(tool);
			const rendered = transcript.render(80).map(row => Bun.stripANSI(row));
			const cards = tools.map(tool => trimBlankEdges(tool.render(80)).length);
			// Rows of each card, then the separators the transcript put between them.
			const blankAfter = (count: number) => rendered[count] ?? "";
			expect(blankAfter(cards[0]!)).not.toBe("");
			expect(blankAfter(cards[0]! + cards[1]!)).toBe("");
			expect(blankAfter(cards[0]! + cards[1]! + 1 + cards[2]!)).toBe("");
			expect(rendered).toHaveLength(cards[0]! + cards[1]! + 1 + cards[2]! + 1 + cards[3]!);
			// The run's last card carries the run's total, like a read group; a lone card does not.
			expect(rendered[cards[0]! + cards[1]! - 1]).toContain("Write (2)");
			expect(rendered.filter(row => /(Write|Edit) \(\d+\)/.test(row))).toHaveLength(1);

			// Retirement under a short viewport keeps the same layout in scrollback.
			const pressured = new TranscriptContainer();
			const screen = new Screen(pressured, 80);
			for (const tool of tools) {
				pressured.addChild(tool);
				screen.settle(4);
			}
			expect(screen.rows.map(row => Bun.stripANSI(row))).toEqual(rendered);
		} finally {
			for (const tool of tools) tool.dispose();
			stopSharedSpinnerTicker();
		}
	});

	it("stacks one edit call's per-file cards flush, like separate calls", () => {
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const files = ["/tmp/a.txt", "/tmp/b.txt", "/tmp/c.txt"];
		const input = `*** Begin Patch\n${files.map(file => `[${file}#AAAA]\nPUT 2.=2:\n+new`).join("\n")}\n*** End Patch\n`;
		const tool = new ToolExecutionComponent("edit", { input }, { useBuiltInRenderer: true }, undefined, ui);
		try {
			tool.setArgsComplete("multi");
			tool.setExecutionStarted("multi");
			const perFileResults = files.map(path => ({ path, diff: "-2|old\n+2|new", firstChangedLine: 2 }));
			tool.updateResult({
				content: [{ type: "text", text: "ok" }],
				details: { diff: "", perFileResults },
				isError: false,
			});
			const transcript = new TranscriptContainer();
			transcript.addChild(tool);
			const rows = transcript.render(80).map(row => Bun.stripANSI(row));
			// One header per file, no blank row anywhere between the cards, and the files' total under them.
			expect(rows.filter(row => row.includes("Edit:"))).toHaveLength(3);
			expect(rows.filter(row => row.trim() === "")).toEqual([]);
			expect(rows.at(-1)).toContain("Edit (3)");
		} finally {
			tool.dispose();
			stopSharedSpinnerTicker();
		}
	});

	it("starts a new run below a run whose total already reached scrollback", () => {
		// History never changes: a later write cannot slide under a total that already retired.
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const write = (path: string, index: number) => {
			const tool = new ToolExecutionComponent("write", { path, content: "row\n" }, {}, undefined, ui);
			tool.setArgsComplete(`w-${index}`);
			tool.setExecutionStarted(`w-${index}`);
			tool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
			return tool;
		};
		const tools = [write("a.txt", 0), write("b.txt", 1), write("c.txt", 2)];
		try {
			const transcript = new TranscriptContainer();
			const screen = new Screen(transcript, 80);
			transcript.addChild(tools[0]!);
			transcript.addChild(tools[1]!);
			screen.settle(1);
			expect(screen.history.some(row => Bun.stripANSI(row).includes("Write (2)"))).toBe(true);
			transcript.addChild(tools[2]!);
			screen.settle(1);
			const rows = screen.rows.map(row => Bun.stripANSI(row));
			expect(rows).toEqual(transcript.render(80).map(row => Bun.stripANSI(row)));
			const total = rows.findIndex(row => row.includes("Write (2)"));
			expect(rows[total + 1]).toBe("");
			expect(rows.filter(row => /Write \(\d+\)/.test(row))).toHaveLength(1);
		} finally {
			for (const tool of tools) tool.dispose();
			stopSharedSpinnerTicker();
		}
	});

	it("keeps an unfinished tool card whole when a block follows it and everything fits", () => {
		// The shrink to a few rows only buys room on a full screen. Applied to a card that fits,
		// it showed as a third stage: full preview, then two rows, then the full result.
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const content = Array.from({ length: 12 }, (_, row) => `row ${row + 1}`).join("\n");
		const cards = [
			new ToolExecutionComponent("write", { path: "a.txt", content }, {}, undefined, ui),
			new ToolExecutionComponent("bash", { command: content }, {}, undefined, ui),
		];
		const others: ToolExecutionComponent[] = [];
		try {
			for (const [index, card] of cards.entries()) {
				card.setArgsComplete(`run-${index}`);
				card.setExecutionStarted(`run-${index}`);
				const next = new ToolExecutionComponent("read", { path: "b.txt" }, {}, undefined, ui);
				others.push(next);
				const transcript = new TranscriptContainer();
				transcript.addChild(card);
				const alone = transcript.renderViewport(80, 60, frame).map(row => Bun.stripANSI(row));
				transcript.addChild(next);
				const rows = transcript.renderViewport(80, 60, frame).map(row => Bun.stripANSI(row));
				expect(rows.slice(0, alone.length)).toEqual(alone);
			}
			// On a full screen, preserve the waiting write's frame instead of exposing a headless body tail.
			const next = new ToolExecutionComponent("read", { path: "c.txt" }, {}, undefined, ui);
			others.push(next);
			const transcript = new TranscriptContainer();
			transcript.addChild(cards[0]!);
			transcript.addChild(next);
			const tight = transcript.renderViewport(80, 8, frame).map(row => Bun.stripANSI(row));
			expect(tight[0]).toContain("Write");
			expect(tight.some(row => row.includes("c.txt"))).toBe(true);
		} finally {
			for (const card of [...cards, ...others]) card.dispose();
			stopSharedSpinnerTicker();
		}
	});

	it("lets a write waiting for its result scroll off instead of cutting the newest card's head", () => {
		// The waiting write was pinned at the top of a full screen, so a tall eval under it lost its
		// header and showed only its middle rows.
		const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
		const content = Array.from({ length: 30 }, (_, row) => `row ${row + 1}`).join("\n");
		const write = new ToolExecutionComponent("write", { path: "a.txt", content }, {}, undefined, ui);
		const code = Array.from({ length: 40 }, (_, row) => `// SOURCE_${row + 1}`).join("\n");
		const evaluation = new ToolExecutionComponent("eval", { language: "js", code }, {}, undefined, ui);
		try {
			write.setArgsComplete("write");
			write.setExecutionStarted("write");
			evaluation.setArgsComplete("eval");
			evaluation.setExecutionStarted("eval");
			const transcript = new TranscriptContainer();
			transcript.addChild(write);
			transcript.addChild(evaluation);
			const rows = transcript.renderViewport(80, 20, frame).map(row => Bun.stripANSI(row));
			const header = Bun.stripANSI(evaluation.render(80).find(row => row.trim() !== "") ?? "");
			expect(rows).toContain(header);
		} finally {
			write.dispose();
			evaluation.dispose();
			stopSharedSpinnerTicker();
		}
	});

	it("keeps a squeezed compact block's head first, and stops packing one squeezed to nothing", () => {
		setTranscriptPresenters([() => ({ compact: { rows: ["row one", "row two"] } })]);
		try {
			const skill = new PresentedBlock(
				plain("skill body"),
				messageBlock(createCustomMessage("skill-prompt", "body", true, { name: "unslop" }, "2026-01-01")),
			);
			skill.setTranscriptAllocation(2, frame);
			const rows = skill.render(40).map(row => Bun.stripANSI(row).trimEnd());
			expect(rows).toEqual(["• Skill unslop", "  row one"]);
			expect(skill.isTranscriptBlockCompact()).toBe(true);

			skill.setTranscriptAllocation(0, frame);
			expect(skill.render(40)).toEqual([]);
			expect(skill.isTranscriptBlockCompact()).toBe(false);

			const ui = { requestRender: () => {}, requestComponentRender: () => {}, resetDisplay: () => {} };
			const tool = new ToolExecutionComponent("bash", { command: "echo one" }, {}, undefined, ui);
			try {
				tool.setArgsComplete("call-squeezed");
				tool.setTranscriptAllocation(0, frame);
				expect(tool.render(40)).toEqual([]);
				expect(tool.isTranscriptBlockCompact()).toBe(false);
			} finally {
				tool.dispose();
				stopSharedSpinnerTicker();
			}
		} finally {
			setTranscriptPresenters([]);
		}
	});

	it("retires compact runs under pressure without duplicating, dropping or adding a row", () => {
		const screen = buildUnderPressure();
		expect(screen.viewport).toEqual(["t3", "c4", "c5", "c6"]);
	});

	it("replays packed history row for row after a presentation reset", () => {
		const screen = buildUnderPressure();
		// The reset forgets the split head, which then retires again.
		screen.transcript.resetStableEmission();
		screen.replay();
		screen.settle(4);
		expect(screen.rows).toEqual([...screen.transcript.render(40)]);
	});

	it("replays a split compact block at a new width without a separator inside the run", () => {
		const words = Array.from({ length: 24 }, (_, i) => `w${i}`);
		const transcript = new TranscriptContainer();
		const screen = new Screen(transcript, 40);
		transcript.addChild(compact("a"));
		transcript.addChild(new Block(width => wrapWords(words, width), true));
		transcript.addChild(compact("b"));
		screen.settle(3);
		// The wrapped block straddles the top edge: its first row is in history.
		expect(screen.history).toEqual(["a", wrapWords(words, 40)[0]!]);

		screen.width = 16;
		screen.replay();
		screen.settle(3);
		expect(screen.rows).toEqual([...transcript.render(16)]);
	});

	it("shows the separator a retired compact block withheld once its live neighbor stops being compact", () => {
		const transcript = new TranscriptContainer();
		const screen = new Screen(transcript, 40);
		const next = compact("c2");
		for (const block of [compact("c1"), next, compact("c3")]) transcript.addChild(block);
		screen.settle(2);
		expect(screen.history).toEqual(["c1"]);

		next.compact = false;
		screen.settle(5);
		expect(screen.viewport).toEqual(["", "c2", "", "c3"]);
		expect(screen.rows).toEqual([...transcript.render(40)]);

		// The owed blank retires with the block, once.
		screen.settle(1);
		expect(screen.history).toEqual(["c1", "", "c2", ""]);
		expect(screen.rows).toEqual([...transcript.render(40)]);
	});

	it("retires only the owed blank while every row of the block below it is still on screen", () => {
		const transcript = new TranscriptContainer();
		const screen = new Screen(transcript, 40);
		const next = compact("c2");
		for (const block of [compact("c1"), next, compact("c3")]) transcript.addChild(block);
		screen.settle(2);
		next.compact = false;

		screen.settle(3);
		expect(screen.history).toEqual(["c1", ""]);
		expect(screen.viewport).toEqual(["c2", "", "c3"]);
	});

	it("keeps a separator history already holds without repeating it when the blocks pack later", () => {
		const transcript = new TranscriptContainer();
		const screen = new Screen(transcript, 40);
		const next = plain("n2");
		for (const block of [compact("c1"), next, compact("c3")]) transcript.addChild(block);
		screen.settle(3);
		expect(screen.history).toEqual(["c1", ""]);

		next.compact = true;
		screen.settle(3);
		expect(screen.viewport).toEqual(["n2", "c3"]);
	});

	it("never opens a separator inside a block split across history and the viewport", () => {
		const transcript = new TranscriptContainer();
		const screen = new Screen(transcript, 40);
		const split = compact("u1", "u2", "u3");
		for (const block of [compact("a"), split, compact("b")]) transcript.addChild(block);
		screen.settle(3);
		expect(screen.history).toEqual(["a", "u1"]);

		// Its head is already history: only the separator below it can open.
		split.compact = false;
		screen.settle(4);
		expect(screen.viewport).toEqual(["u2", "u3", "", "b"]);
	});

	it("withholds the separator after a retired compact block until the next block shows whether it packs", () => {
		const transcript = new TranscriptContainer();
		const screen = new Screen(transcript, 40);
		for (const block of [compact("c1"), compact("c2"), plain()]) transcript.addChild(block);
		screen.settle(0);
		expect(screen.history).toEqual(["c1", "c2"]);

		transcript.addChild(compact("c3"));
		screen.settle(3);
		expect(screen.rows).toEqual(["c1", "c2", "c3"]);

		transcript.addChild(plain("note"));
		screen.settle(3);
		expect(screen.rows).toEqual(["c1", "c2", "c3", "", "note"]);
	});
});
