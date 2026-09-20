import { beforeAll, describe, expect, it } from "bun:test";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./terminal-multiplexer-environment";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

const COLUMNS = 80;
const ROWS = 20;
const PREFIX = "Transcript row ";

interface Harness {
	terminal: VirtualTerminal;
	scheduler: VirtualRenderScheduler;
	composer: Composer;
	transcript: TranscriptContainer;
}

function row(index: number): { render: () => string[] } {
	return { render: () => [`${PREFIX}${index}`] };
}

function makeHarness(): Harness {
	const terminal = new VirtualTerminal(COLUMNS, ROWS);
	const scheduler = new VirtualRenderScheduler();
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
	});
	const transcript = new TranscriptContainer();
	const editor = new Container();
	editor.addChild(new Text("EDITOR", 0, 0));
	composer.setRuntimeChildren([transcript, editor]);
	composer.start({ playWelcomeIntro: false });
	return { terminal, scheduler, composer, transcript };
}

function transcriptIndices(terminal: VirtualTerminal): number[] {
	return terminal
		.getScrollBuffer()
		.map(line => Bun.stripANSI(line).trimEnd())
		.filter(line => line.startsWith(PREFIX))
		.map(line => Number(line.slice(PREFIX.length)));
}

async function settle(h: Harness): Promise<void> {
	h.composer.ui.requestRender();
	await h.scheduler.settle(h.terminal);
}

beforeAll(async () => {
	await initTheme();
});

describe("transcript rebuild ledger", () => {
	it("does not re-commit rows already in native scrollback when the transcript is rebuilt", async () => {
		const h = makeHarness();
		try {
			// Stream well past the 20-row terminal one block at a time, so history
			// retires through many commit cycles and older rows leave the
			// terminal's borrowed window entirely.
			for (let index = 0; index < 40; index++) {
				h.transcript.addChild(row(index));
				await settle(h);
			}
			expect(transcriptIndices(h.terminal)).toEqual(Array.from({ length: 40 }, (_, i) => i));

			// The reconciliation must be quiet: the TUI's fallback for a ledger it
			// cannot match is a destructive replay (ED3), which wipes the user's
			// native scrollback. Record what reaches the terminal from here on.
			const written: string[] = [];
			const write = h.terminal.write.bind(h.terminal);
			h.terminal.write = (data: string) => {
				written.push(data);
				write(data);
			};
			// A rebuild (as /shake, compaction, or a cancelled submission does)
			// clears the container and reconstructs equivalent blocks, then
			// streaming continues.
			h.transcript.clear();
			for (let index = 0; index < 40; index++) h.transcript.addChild(row(index));
			await settle(h);
			for (let index = 40; index < 60; index++) {
				h.transcript.addChild(row(index));
				await settle(h);
			}

			// Regression: the reconstructed blocks started with an empty emission
			// ledger, so the rows native scrollback already held were offered
			// again as a fresh append. Depending on what the terminal still had
			// borrowed, that either duplicated the transcript or forced the TUI
			// into a destructive replay to hide the mismatch. Neither may happen.
			expect(transcriptIndices(h.terminal)).toEqual(Array.from({ length: 60 }, (_, i) => i));
			expect(written.join("")).not.toMatch(/\x1b\[3J/);
		} finally {
			h.composer.stop();
		}
	});

	it("re-emits only the suffix that diverges from the committed ledger", async () => {
		const h = makeHarness();
		try {
			for (let index = 0; index < 40; index++) h.transcript.addChild(row(index));
			await settle(h);

			// The rebuild keeps the first 30 blocks and replaces the rest with
			// different content. Rows 0-19 were committed and 20-29 borrowed into
			// native scrollback, so they stay exactly once; 30-39 only ever lived on
			// screen and are legitimately replaced by the new tail.
			h.transcript.clear();
			for (let index = 0; index < 30; index++) h.transcript.addChild(row(index));
			for (let index = 100; index < 110; index++) h.transcript.addChild(row(index));
			await settle(h);
			for (let index = 110; index < 130; index++) {
				h.transcript.addChild(row(index));
				await settle(h);
			}

			const indices = transcriptIndices(h.terminal);
			const retained = Array.from({ length: 30 }, (_, i) => i);
			const replaced = Array.from({ length: 30 }, (_, i) => 100 + i);
			expect(indices).toEqual([...retained, ...replaced]);
		} finally {
			h.composer.stop();
		}
	});
});
