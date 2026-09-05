import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { Composer } from "@oh-my-pi/pi-coding-agent/modes/composer";
import { type Component } from "@oh-my-pi/pi-tui";
import { StressRenderScheduler } from "../../tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

/**
 * Finalized history block. With `tracked`, reports a post-finalize content
 * version like `AssistantMessageComponent`; otherwise it is version-untracked
 * like most tool blocks.
 */
class HistoryBlock implements Component {
	#lines: readonly string[];
	getTranscriptBlockVersion?: () => number;
	constructor(lines: readonly string[], tracked: boolean) {
		this.#lines = lines;
		if (tracked) this.getTranscriptBlockVersion = () => 1;
	}
	render(width: number): readonly string[] {
		return this.#lines.map(line => line.slice(0, width));
	}
	isTranscriptBlockFinalized(): boolean {
		return true;
	}
}

/** Streaming live block with a settled prefix, like a streaming assistant reply. */
class LiveBlock implements Component {
	lines: string[] = ["live-000"];
	settled = 0;
	render(width: number): readonly string[] {
		return this.lines.map(line => line.slice(0, width));
	}
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
	getTranscriptBlockSettledRows(): number {
		return this.settled;
	}
}

// Exercise the product-owned frame provider, which transfers finalized
// transcript rows into native scrollback while retaining the streaming tail.
// Mounting TranscriptContainer directly into TUI bypasses that transfer.
async function streamPastCommit(tracked: boolean): Promise<Map<string, number>> {
	const term = new VirtualTerminal(40, 6);
	Object.defineProperty(term, "isNativeViewportAtBottom", { configurable: true, value: () => undefined });
	const scheduler = new StressRenderScheduler();
	const composer = new Composer({
		terminal: term,
		preferences: { quiet: true },
		tuiOptions: { renderScheduler: scheduler },
	});
	const tui = composer.ui;
	const chat = new TranscriptContainer();
	const historyRows: string[] = [];
	for (let i = 0; i < 6; i++) {
		const rows = [`box-${i}-alpha`, `box-${i}-beta`];
		historyRows.push(...rows);
		chat.addChild(new HistoryBlock(rows, tracked));
	}
	const live = new LiveBlock();
	chat.addChild(live);
	composer.setRuntimeChildren([chat]);

	try {
		composer.start({ playWelcomeIntro: false });
		await scheduler.drain(term);
		// Grow the live block one row per frame with the settled prefix trailing
		// by one, pushing the finalized history through commit and compaction.
		for (let i = 1; i < 40; i++) {
			live.lines.push(`live-${String(i).padStart(3, "0")}`);
			live.settled = live.lines.length - 1;
			tui.requestRender();
			await scheduler.drain(term);
		}
	} finally {
		composer.stop();
		await term.flush();
	}

	const counts = new Map<string, number>();
	for (const row of term.getScrollBuffer()) {
		const text = Bun.stripANSI(row).trimEnd();
		if (text.length === 0) continue;
		counts.set(text, (counts.get(text) ?? 0) + 1);
	}
	// Loss check alongside the duplication check: every history row must have
	// reached the tape exactly once.
	for (const row of historyRows) expect(counts.get(row) ?? 0).toBe(1);
	return counts;
}

async function finalizeThenStartSecondStream(): Promise<Map<string, number>> {
	const term = new VirtualTerminal(40, 6);
	Object.defineProperty(term, "isNativeViewportAtBottom", { configurable: true, value: () => undefined });
	const scheduler = new StressRenderScheduler();
	const composer = new Composer({
		terminal: term,
		preferences: { quiet: true },
		tuiOptions: { renderScheduler: scheduler },
	});
	const tui = composer.ui;
	const chat = new TranscriptContainer();
	const completedRows = ["first-thinking", "first-prose"];
	chat.addChild(new HistoryBlock(completedRows, true));
	const live = new LiveBlock();
	live.lines = ["second-live-000"];
	chat.addChild(live);
	composer.setRuntimeChildren([chat]);

	try {
		composer.start({ playWelcomeIntro: false });
		for (let i = 1; i < 20; i++) {
			live.lines.push(`second-live-${String(i).padStart(3, "0")}`);
			live.settled = live.lines.length - 1;
			tui.requestRender();
			await scheduler.drain(term);
		}
	} finally {
		composer.stop();
		await term.flush();
	}

	const counts = new Map<string, number>();
	for (const row of term.getScrollBuffer()) {
		const text = Bun.stripANSI(row).trimEnd();
		if (text.length === 0) continue;
		counts.set(text, (counts.get(text) ?? 0) + 1);
	}
	return counts;
}

describe("transcript committed history", () => {
	it("keeps version-tracked committed history exactly once on the tape", async () => {
		const counts = await streamPastCommit(true);
		expect([...counts.entries()].filter(([, count]) => count > 1)).toEqual([]);
	});

	it("keeps version-untracked committed history exactly once on the tape", async () => {
		const counts = await streamPastCommit(false);
		expect([...counts.entries()].filter(([, count]) => count > 1)).toEqual([]);
	});

	it("keeps a finalized assistant block exactly once when the next stream starts", async () => {
		const counts = await finalizeThenStartSecondStream();
		expect(counts.get("first-thinking") ?? 0).toBe(1);
		expect(counts.get("first-prose") ?? 0).toBe(1);
	});
});
