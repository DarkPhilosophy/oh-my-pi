import { beforeAll, expect, it, vi } from "bun:test";
import { Text, TUI, type Component } from "@oh-my-pi/pi-tui";
import { CodexResetFireworksController } from "@oh-my-pi/pi-tui/overlays/codex-reset-fireworks";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { VirtualTerminal } from "./virtual-terminal";

beforeAll(async () => {
	await initTheme();
});

it.each([2, 60])("keeps a reset notice out of the %i-row chat history and leaves typing active", async lineCount => {
	const terminal = new VirtualTerminal(120, 40);
	const composer = new Composer({ terminal, preferences: { quiet: true } });
	const ui = composer.ui;
	let input = "";
	const chat = Array.from({ length: lineCount }, (_, i) => `CHAT_CONTEXT_${i}`);
	const editor: Component = {
		render: () => [`INPUT:${input}`],
		handleInput: data => {
			input += data;
		},
	};
	const transcript = new TranscriptContainer();
	transcript.addChild(new Text(chat.join("\n"), 0, 0));
	composer.setRuntimeChildren([transcript, editor]);
	composer.start({ playWelcomeIntro: false });
	ui.setFocus(editor);
	const controller = new CodexResetFireworksController({ ui });
	try {
		await terminal.waitForRender();
		expect([
			...(terminal
				.getScrollBuffer()
				.join("\n")
				.match(/CHAT_CONTEXT_\d+/g) ?? []),
		]).toEqual(chat);
		controller.show({ kind: "unscheduled-weekly-reset" });
		await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("Weekly usage")));
		const viewport = terminal.getViewport();
		const top = viewport.findIndex(row => row.includes("╭"));
		const left = viewport[top]!.indexOf("╭");
		expect(top).toBeGreaterThan(0);
		expect(left).toBeGreaterThan(0);
		expect(viewport[top]!.indexOf("╮")).toBeLessThan(119);
		expect(viewport[0]).toContain("CHAT_CONTEXT");
		ui.injectDebugInput("still typing");
		expect(input).toBe("still typing");
		ui.requestRender();
		await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("INPUT:still typing")));
		ui.injectDebugInput("\x1b");
		await Promise.resolve();
		await terminal.waitForRender(() => !terminal.getViewport().some(row => row.includes("Weekly usage")));
		expect(input).toBe("still typing");
		const tape = terminal.getScrollBuffer().join("\n");
		expect(tape).not.toContain("Weekly usage");
		expect([...(tape.match(/CHAT_CONTEXT_\d+/g) ?? [])]).toEqual(chat);
	} finally {
		controller.dispose();
		composer.stop();
	}
});

it("does not leave an existing fullscreen view when the notification opens or closes", async () => {
	const terminal = new VirtualTerminal(120, 40);
	const ui = new TUI(terminal);
	ui.addChild(new Text("BASE_CHAT", 0, 0));
	const input: string[] = [];
	const menu: Component = {
		render: () => ["FULLSCREEN_VIEW"],
		handleInput: key => {
			input.push(key);
		},
	};
	const writes = vi.spyOn(terminal, "write");
	const controller = new CodexResetFireworksController({ ui });
	ui.start();
	try {
		const modal = ui.showOverlay(menu, { fullscreen: true, width: "100%", maxHeight: "100%" });
		await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("FULLSCREEN_VIEW")));
		writes.mockClear();
		controller.show({ kind: "unscheduled-weekly-reset" });
		await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("Weekly usage")));
		ui.injectDebugInput("menu-key");
		expect(input).toEqual(["menu-key"]);
		expect(writes.mock.calls.map(call => call[0]).join("")).not.toContain("\x1b[?1049l");
		ui.injectDebugInput("\x1b");
		await Promise.resolve();
		await terminal.waitForRender(() => !terminal.getViewport().some(row => row.includes("Weekly usage")));
		expect(terminal.getViewport().join("\n")).toContain("FULLSCREEN_VIEW");
		expect(writes.mock.calls.map(call => call[0]).join("")).not.toContain("\x1b[?1049l");
		modal.hide();
		await terminal.waitForRender(() => terminal.getViewport().some(row => row.includes("BASE_CHAT")));
	} finally {
		controller.dispose();
		ui.stop();
		writes.mockRestore();
	}
});
