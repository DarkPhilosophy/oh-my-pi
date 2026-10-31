import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { TranscriptContainer, trimBlankEdges } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { Text, type TUI } from "@oh-my-pi/pi-tui";
import { renderOutputBlockStaged, renderOutputBlockViewport } from "@oh-my-pi/pi-tui/render/output-block";
import { formatEarlierLines } from "@oh-my-pi/pi-tui/render/render-utils";
import { VirtualTerminal } from "./virtual-terminal";

describe("native streaming edit previews", () => {
	beforeAll(async () => {
		await initTheme();
	});

	function createComponent(onRender: () => void): ToolExecutionComponent {
		const ui = { requestRender: onRender } as unknown as TUI;
		const tool = { mode: "replace" } as unknown as AgentTool;
		return new ToolExecutionComponent(
			"edit",
			{ path: "/tmp/mod.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
			{},
			tool,
			ui,
			"/tmp",
		);
	}

	test("combines source and viewport elision without losing the original line count", () => {
		const source = renderOutputBlockStaged(
			{
				header: "Preview",
				width: 100,
				sections: [
					{
						lines: [
							formatEarlierLines({ hidden: 5, shown: 10 }),
							...Array.from({ length: 10 }, (_, i) => `CONTENT_${i + 5}`),
						],
					},
				],
			},
			theme,
		).lines;
		const clipped = renderOutputBlockViewport("Preview", source, 100, 6, theme)!;
		const text = clipped.map(line => Bun.stripANSI(line)).join("\n");
		expect(text).toContain("12 earlier lines, showing 3 of 15");
		expect(text.match(/earlier/g)).toHaveLength(1);
		expect(text).toContain("CONTENT_12");
		expect(text).not.toContain("CONTENT_11");
		const narrower = renderOutputBlockViewport("Preview", clipped, 100, 5, theme)!;
		const next = narrower.map(line => Bun.stripANSI(line)).join("\n");
		expect(next).toContain("13 earlier lines, showing 2 of 15");
		expect(next.match(/earlier/g)).toHaveLength(1);
	});

	test("keeps one expansion marker when a real streaming command is squeezed and expanded", () => {
		const ui = { requestRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent(
			"bash",
			{
				command: Array.from({ length: 80 }, (_, i) => `echo COMMAND_ROW_${i}`).join("\n"),
			},
			{},
			undefined,
			ui,
		);
		try {
			const source = trimBlankEdges(component.render(120));
			expect(source.join("\n")).toContain("earlier");
			const compact = component
				.renderTranscriptCompact(120, 8, source)
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(compact.match(/earlier/g)).toHaveLength(1);
			expect(compact).toMatch(/earlier lines?, showing \d+ of \d+/);
			expect(compact).toContain("COMMAND_ROW_79");
			expect(compact).not.toContain("COMMAND_ROW_0");
			component.setExpanded(true);
			const expanded = component
				.render(120)
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(expanded).toContain("COMMAND_ROW_0");
			expect(expanded).toContain("COMMAND_ROW_79");
			expect(expanded).not.toContain("earlier");
		} finally {
			component.stopAnimation();
		}
	});

	test("keeps a blank row on each side of statistics as a long edit squeezes a running Bash", () => {
		const ui = { requestRender() {} } as unknown as TUI;
		const bash = new ToolExecutionComponent("bash", { command: "echo running" }, {}, undefined, ui);
		const edit = createComponent(() => {});
		const transcript = new TranscriptContainer();
		for (let index = 0; index < 30; index++) transcript.addChild(new Text(`OLD_BODY_${index}`, 0, 0));
		transcript.addChild(bash);
		transcript.addChild(new Text("TURN_STATS", 0, 1));
		transcript.addChild(edit);
		const assertSpacing = (rows: readonly string[]) => {
			const terminal = new VirtualTerminal(100, rows.length + 1);
			terminal.write(rows.join("\r\n"));
			const displayed = terminal.getViewport().map(row => row.trimEnd());
			const index = displayed.findIndex(row => row.includes("TURN_STATS"));
			expect(index).toBeGreaterThan(0);
			expect(displayed[index - 1]).toBe("");
			expect(displayed[index + 1]).toBe("");
		};
		try {
			bash.setArgsComplete();
			bash.setExecutionStarted();
			edit.setArgsComplete();
			const diff =
				"@@ -1 +1,80 @@\n-old\n" +
				Array.from({ length: 80 }, (_, index) => `+const LONG_EDIT_${index} = ${index};`).join("\n");
			edit.updateStreamPreview({
				generation: 1,
				streaming: true,
				files: [{ path: "mod.ts", diff, firstChangedLine: 1 }],
			});
			for (const capacity of [30, 18, 12, 10]) {
				const viewport = transcript.renderViewport(100, capacity, { tick: capacity, now: capacity });
				expect(Bun.stripANSI(viewport.join("\n"))).toContain("echo running");
				assertSpacing(viewport);
			}
			bash.updateResult({ content: [{ type: "text", text: "finished" }] }, false);
			edit.updateResult(
				{ content: [{ type: "text", text: "edited" }], details: { diff, firstChangedLine: 1 } },
				false,
			);
			const history: string[] = [];
			for (let tick = 100; tick < 110; tick++) {
				const batch = transcript.peekFinalizedBatch(100, 3);
				if (!batch) break;
				history.push(...batch.rows);
				transcript.acknowledgeFinalizedBatch(batch.id);
			}
			assertSpacing([...history, ...transcript.renderViewport(100, 3, { tick: 110, now: 110 })]);
		} finally {
			bash.stopAnimation();
			edit.stopAnimation();
		}
	});
	test("merges a gutter-prefixed elision marker instead of stacking a second one", () => {
		const source = renderOutputBlockStaged(
			{
				header: "Preview",
				width: 100,
				sections: [
					{
						lines: [
							...Array.from({ length: 8 }, (_, i) => `${theme.tree.vertical} CONTENT_${i}`),
							`${theme.tree.vertical} ${formatEarlierLines({ hidden: 5, shown: 10 })}`,
							`${theme.tree.vertical} CONTENT_8`,
							`${theme.tree.vertical} CONTENT_9`,
						],
					},
				],
			},
			theme,
		).lines;
		const clipped = renderOutputBlockViewport("Preview", source, 100, 6, theme)!;
		const text = clipped.map(line => Bun.stripANSI(line)).join("\n");
		expect(text.match(/earlier/g)).toHaveLength(1);
	});

	test("does not mistake quoted source text for a truncation marker", () => {
		const sourceLine = 'print("… (5 earlier lines, showing 10 of 15)")';
		const source = renderOutputBlockStaged(
			{
				header: "Preview",
				width: 100,
				sections: [{ lines: [sourceLine, "LAST_ROW"] }],
			},
			theme,
		).lines;
		const clipped = renderOutputBlockViewport("Preview", source, 100, 4, theme)!;
		expect(clipped.map(row => Bun.stripANSI(row)).join("\n")).toContain(sourceLine);
	});
	test("preserves multi-file diff colors and the following terminal text when squeezed", () => {
		const component = createComponent(() => {});
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		try {
			component.updateStreamPreview({
				generation: 1,
				streaming: true,
				files: ["first.ts", "second.ts"].map(path => ({
					path,
					diff:
						"@@ -1 +1,20 @@\n-old\n" +
						Array.from({ length: 20 }, (_, index) => `+const TARGET_${index} = ${index};`).join("\n"),
					firstChangedLine: 1,
				})),
			});
			const full = component.render(100);
			const bounded = transcript.renderViewport(100, 10, { tick: 0, now: 0 });
			const baseline = new VirtualTerminal(100, 100);
			const actual = new VirtualTerminal(100, 100);
			baseline.write(full.join("\r\n") + "\r\nFOLLOWING_TEXT");
			actual.write(bounded.join("\r\n") + "\r\nFOLLOWING_TEXT");
			const before = baseline.getViewport().findLastIndex(line => line.includes("TARGET_19"));
			const after = actual.getViewport().findIndex(line => line.includes("TARGET_19"));
			expect(after).toBeGreaterThanOrEqual(0);
			const startBefore = baseline.getViewport()[before]!.indexOf("TARGET_19");
			const startAfter = actual.getViewport()[after]!.indexOf("TARGET_19");
			expect(actual.getViewportRowForegroundValues(after).slice(startAfter, startAfter + 9)).toEqual(
				baseline.getViewportRowForegroundValues(before).slice(startBefore, startBefore + 9),
			);
			expect(actual.getViewportRowBackgroundValues(after).slice(startAfter, startAfter + 9)).toEqual(
				baseline.getViewportRowBackgroundValues(before).slice(startBefore, startBefore + 9),
			);
			const following = actual.getViewport().findIndex(line => line.includes("FOLLOWING_TEXT"));
			const beforeFollowing = baseline.getViewport().findIndex(line => line.includes("FOLLOWING_TEXT"));
			expect(actual.getViewportRowForegroundValues(following)).toEqual(
				baseline.getViewportRowForegroundValues(beforeFollowing),
			);
			expect(actual.getCellDim(following, 0)).toBe(false);
			expect(bounded.map(line => Bun.stripANSI(line)).join("\n")).toContain("second.ts");
		} finally {
			component.stopAnimation();
		}
	});

	test.each([1, 2, 3, 4, 6])("keeps a streaming diff readable within %i viewport rows", rows => {
		const component = createComponent(() => {});
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		try {
			component.updateStreamPreview({
				generation: 1,
				streaming: true,
				files: [
					{
						path: "/tmp/mod.ts",
						diff:
							"@@ -1 +1,50 @@\n-old\n" +
							Array.from({ length: 50 }, (_, index) => `+const value${index} = ${index};`).join("\n"),
						firstChangedLine: 1,
					},
				],
			});
			const visible = transcript
				.renderViewport(100, rows, { tick: 0, now: 0 })
				.map(line => Bun.stripANSI(line).trim());
			expect(visible.length).toBeLessThanOrEqual(rows);
			if (rows < 4) {
				expect(visible.some(line => line.startsWith("╭") || line.startsWith("╰"))).toBe(false);
				expect(visible.join("\n")).toContain("Edit");
			} else {
				expect(visible[0]).toStartWith("╭");
				expect(visible.at(-1)).toStartWith("╰");
				expect(visible.join("\n")).toContain("const value49 = 49;");
				expect(visible.join("\n")).toContain("earlier lines, showing");
			}
		} finally {
			component.stopAnimation();
		}
	});

	test("fits an untruncated one-line diff and both borders in three rows", () => {
		const component = createComponent(() => {});
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		try {
			component.updateStreamPreview({
				generation: 1,
				streaming: true,
				files: [{ path: "/tmp/mod.ts", diff: "+const visible = true;", firstChangedLine: 1 }],
			});
			const visible = transcript.renderViewport(100, 3, { tick: 0, now: 0 }).map(line => Bun.stripANSI(line).trim());
			expect(visible).toHaveLength(3);
			expect(visible[0]).toStartWith("╭");
			expect(visible[1]).toContain("const visible = true;");
			expect(visible[2]).toStartWith("╰");
		} finally {
			component.stopAnimation();
		}
	});

	test("keeps the latest custom tool content inside a bounded frame", () => {
		const tool = {
			name: "custom_preview",
			renderCall: () => new Text(Array.from({ length: 20 }, (_, index) => `CUSTOM_${index}`).join("\n"), 0, 0),
		} as unknown as AgentTool;
		const component = new ToolExecutionComponent("custom_preview", {}, {}, tool, {
			requestRender() {},
		} as unknown as TUI);
		const transcript = new TranscriptContainer();
		transcript.addChild(component);
		try {
			const visible = transcript.renderViewport(80, 5, { tick: 0, now: 0 }).map(line => Bun.stripANSI(line).trim());
			expect(visible).toHaveLength(5);
			expect(visible[0]).toStartWith("╭");
			expect(visible.at(-1)).toStartWith("╰");
			expect(visible.join("\n")).toContain("CUSTOM_18");
			expect(visible.join("\n")).toContain("CUSTOM_19");
		} finally {
			component.stopAnimation();
		}
	});

	test("keeps the published command junction when shrinking its live output stage", () => {
		const staged = renderOutputBlockStaged(
			{
				header: "Command",
				stageTone: "success",
				state: "running",
				width: 80,
				sections: [
					{ lines: ["echo progress"] },
					{
						label: "Output",
						lines: Array.from({ length: 20 }, (_, index) => theme.fg("success", `OUTPUT_${index}`)),
					},
				],
			},
			theme,
		);
		const live = staged.lines.slice(staged.topStageRows);
		const visible = renderOutputBlockViewport("Command", live, 80, 6, theme)!;
		expect(visible).toHaveLength(6);
		expect(visible[0]).toBe(live[0]);
		expect(visible.at(-1)).toBe(live.at(-1));
		expect(visible.map(line => Bun.stripANSI(line)).join("\n")).not.toContain("╭");
		expect(visible.join("\n")).toContain("OUTPUT_19");
		expect(visible.find(line => line.includes("OUTPUT_19"))).toBe(live.find(line => line.includes("OUTPUT_19")));
	});
	test("new batches replace the preview and empty batches retain it", () => {
		let renders = 0;
		const component = createComponent(() => renders++);
		try {
			component.updateStreamPreview({
				generation: 1,
				streaming: true,
				files: [{ path: "/tmp/mod.ts", diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;", firstChangedLine: 1 }],
			});
			const first = Bun.stripANSI(component.render(100).join("\n"));
			expect(first).toContain("const a = 2;");
			expect(renders).toBe(1);

			component.updateStreamPreview({ generation: 2, streaming: true, files: [] });
			expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("const a = 2;");
			expect(renders).toBe(1);

			component.updateStreamPreview({
				generation: 3,
				streaming: true,
				files: [{ path: "/tmp/mod.ts", diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 3;", firstChangedLine: 1 }],
			});
			expect(Bun.stripANSI(component.render(100).join("\n"))).toContain("const a = 3;");
			expect(renders).toBe(2);
		} finally {
			component.stopAnimation();
		}
	});

	test("terminal results reject late preview batches", () => {
		const component = createComponent(() => {});
		try {
			component.updateResult(
				{
					content: [{ type: "text", text: "ok" }],
					details: { diff: "@@ -1 +1 @@\n-old\n+final", firstChangedLine: 1 },
				},
				false,
			);
			component.updateStreamPreview({
				generation: 4,
				streaming: false,
				files: [{ path: "/tmp/mod.ts", diff: "@@ -1 +1 @@\n-old\n+late", firstChangedLine: 1 }],
			});
			const rendered = Bun.stripANSI(component.render(100).join("\n"));
			expect(rendered).toContain("final");
			expect(rendered).not.toContain("late");
		} finally {
			component.stopAnimation();
		}
	});
});
