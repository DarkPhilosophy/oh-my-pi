import { afterEach, beforeAll, expect, it } from "bun:test";
import { stopSharedSpinnerTicker, ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Text } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme(false);
});
let composer: Composer | undefined;
const tools: ToolExecutionComponent[] = [];
afterEach(() => {
	composer?.stop();
	composer = undefined;
	for (const tool of tools.splice(0)) tool.dispose();
	stopSharedSpinnerTicker();
});

for (const expanded of [false, true]) {
	for (const rows of [8, 12, 20, 32]) {
		it(`keeps a multi-file edit preview framed at ${rows} rows (expanded=${expanded})`, async () => {
			const terminal = new VirtualTerminal(100, rows);
			composer = new Composer({ terminal, preferences: { quiet: true } });
			const transcript = new TranscriptContainer();
			transcript.addChild(new Text("Read (2)", 0, 0));
			transcript.addChild(new Text("TURN_STATS", 0, 1));
			const paths = ["/tmp/first.ts", "/tmp/second.ts"];
			const tool = new ToolExecutionComponent(
				"edit",
				{ input: "*** Begin Patch\n" },
				{ useBuiltInRenderer: true },
				undefined,
				composer.ui,
			);
			tools.push(tool);
			tool.setExpanded(expanded);
			transcript.addChild(tool);
			composer.setRuntimeChildren([transcript, composer.editor]);
			composer.start();
			for (const streaming of [true, false]) {
				if (!streaming) {
					tool.setArgsComplete("edit");
					tool.setExecutionStarted("edit");
				}
				tool.updateStreamPreview({
					generation: streaming ? 1 : 2,
					streaming,
					files: paths.map(path => ({
						path,
						firstChangedLine: 1,
						diff:
							"-1|old\n" +
							Array.from(
								{ length: 70 },
								(_, row) => `+${row + 1}|const ROW_${row} = \"${"long value ".repeat(8)}\";`,
							).join("\n"),
					})),
				});
				composer.ui.renderNow();
				await terminal.waitForRender();
				const viewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
				const start = viewport.findIndex(row => /ROW_\d+|second.ts/.test(row));
				expect(start).toBeGreaterThanOrEqual(0);
				const head = viewport.slice(0, start + 1).find(row => row.includes("Edit:"));
				expect(head).toBeDefined();
				if (!streaming) {
					const read = new ToolExecutionComponent(
						"read",
						{ path: "/tmp/following.txt" },
						{ useBuiltInRenderer: true },
						undefined,
						composer.ui,
					);
					tools.push(read);
					transcript.addChild(read);
					composer.ui.renderNow();
					await terminal.waitForRender();
					const nextViewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
					const diff = nextViewport.findIndex(row => /ROW_\d+|second.ts/.test(row));
					if (diff >= 0) {
						const title = nextViewport.slice(0, diff + 1).find(row => row.includes("Edit:"));
						expect(title).toBeDefined();
						expect(nextViewport.slice(0, diff + 1).some(row => row.includes("╭"))).toBe(true);
					}
					const diffText =
						"-1|old\n" +
						Array.from({ length: 70 }, (_, row) => `+${row + 1}|const FINAL_${row} = ${row};`).join("\n");
					tool.updateResult({
						content: [{ type: "text", text: "edited" }],
						details: { perFileResults: paths.map(path => ({ path, diff: diffText, firstChangedLine: 1 })) },
						isError: false,
					});
					read.updateResult({ content: [{ type: "text", text: "FOLLOWING_RESULT" }], isError: false });
					composer.ui.renderNow();
					await terminal.waitForRender();
					const tape = terminal
						.getScrollBuffer()
						.map(row => Bun.stripANSI(row))
						.join("\n");
					expect(tape).not.toMatch(/\bROW_\d+\b/);
					if (expanded) {
						const markers = Array.from(tape.matchAll(/\bFINAL_\d+\b/g), match => match[0]);
						const expected = paths.flatMap(() => Array.from({ length: 70 }, (_, row) => `FINAL_${row}`));
						expect(markers).toEqual(expected);
					}
				}
			}
		});
	}
}

it.each(["read", "bash", "write"])("keeps the newest edit framed after a pending %s and statistics", async previous => {
	const terminal = new VirtualTerminal(100, 24);
	composer = new Composer({ terminal, preferences: { quiet: true } });
	const transcript = new TranscriptContainer();
	if (previous === "read") {
		const group = new ReadToolGroupComponent({ showContentPreview: true });
		group.updateArgs({ path: "/tmp/first.txt" }, "first");
		group.updateResult({ content: [{ type: "text", text: "READ_CONTENT\n".repeat(80) }] }, false, "first");
		group.updateArgs({ path: "/tmp/second.txt" }, "second");
		group.finalize();
		transcript.addChild(group);
	} else {
		const pending = new ToolExecutionComponent(
			previous,
			previous === "write"
				? { path: "/tmp/prior.txt", content: "PRIOR_CONTENT\n".repeat(80) }
				: { command: "echo waiting" },
			{ useBuiltInRenderer: true },
			undefined,
			composer.ui,
		);
		tools.push(pending);
		pending.setArgsComplete("prior");
		pending.setExecutionStarted("prior");
		transcript.addChild(pending);
	}
	transcript.addChild(new Text("TURN_STATS", 0, 1));
	const tool = new ToolExecutionComponent(
		"edit",
		{ input: "*** Begin Patch\n" },
		{ useBuiltInRenderer: true },
		undefined,
		composer.ui,
	);
	tools.push(tool);
	tool.setExpanded(true);
	transcript.addChild(tool);
	composer.setRuntimeChildren([transcript, composer.editor]);
	composer.start();
	for (const streaming of [true, false]) {
		if (!streaming) {
			tool.setArgsComplete("edit");
			tool.setExecutionStarted("edit");
		}
		tool.updateStreamPreview({
			generation: streaming ? 1 : 2,
			streaming,
			files: ["/tmp/first.ts", "/tmp/second.ts"].map(path => ({
				path,
				firstChangedLine: 1,
				diff:
					"-1|old\n" +
					Array.from(
						{ length: 70 },
						(_, row) => `+${row + 1}|const ROW_${row} = \"${"long value ".repeat(8)}\";`,
					).join("\n"),
			})),
		});
		composer.ui.renderNow();
		await terminal.waitForRender();
		const viewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
		const start = viewport.findIndex(row => /ROW_\d+|second.ts/.test(row));
		const head = viewport.slice(0, start + 1).find(row => row.includes("Edit:"));
		expect(head).toBeDefined();
	}
});

it.each(["write", "eval", "bash"])(
	"keeps the visible %s preview framed when a following read takes space",
	async name => {
		const terminal = new VirtualTerminal(100, 20);
		composer = new Composer({ terminal, preferences: { quiet: true } });
		const transcript = new TranscriptContainer();
		const body = Array.from({ length: 80 }, (_, row) => `SOURCE_${row}: ${"wrapped content ".repeat(8)}`).join("\n");
		const args =
			name === "write"
				? { path: "/tmp/output.txt", content: body }
				: name === "bash"
					? { command: body }
					: { language: "js", code: body };
		const preview = new ToolExecutionComponent(name, args, { useBuiltInRenderer: true }, undefined, composer.ui);
		const read = new ToolExecutionComponent(
			"read",
			{ path: "/tmp/following.txt" },
			{ useBuiltInRenderer: true },
			undefined,
			composer.ui,
		);
		tools.push(preview, read);
		preview.setExpanded(true);
		preview.setArgsComplete(name);
		transcript.addChild(preview);
		composer.setRuntimeChildren([transcript, composer.editor]);
		composer.start();
		composer.ui.renderNow();
		await terminal.waitForRender();
		const originalHeader = terminal
			.getViewport()
			.map(row => Bun.stripANSI(row).trimEnd())
			.find(row => row.startsWith("╭"));
		expect(originalHeader).toBeDefined();
		const title = name === "eval" ? originalHeader!.replace(/^╭─+\s*|\s*─+╮$/g, "") : name;
		transcript.addChild(read);
		for (const width of [100, 57]) {
			terminal.resize(width, 20);
			composer.ui.renderNow();
			await terminal.waitForRender();
			const viewport = terminal.getViewport().map(row => Bun.stripANSI(row).trimEnd());
			const source = viewport.findIndex(row => row.includes("SOURCE_"));
			expect(source).toBeGreaterThanOrEqual(0);
			if (source >= 0) {
				expect(viewport.slice(0, source + 1)).toEqual(
					expect.arrayContaining([expect.stringMatching(new RegExp(title, "i"))]),
				);
				expect(viewport.slice(0, source + 1).some(row => row.includes("╭"))).toBe(true);
			}
			expect(viewport.some(row => row.includes("following.txt"))).toBe(true);
		}
	},
);
