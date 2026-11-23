import { describe, expect, it } from "bun:test";
import { setTranscriptActionHandler, type TranscriptAction } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import { setPromptZonesEnabled, UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TUI } from "@oh-my-pi/pi-tui";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { setCopyUrlHandlerReady, setCopyUrlTargetProvider } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { stripTerminalSequences } from "@oh-my-pi/pi-tui/utils";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const PROMPT_START = "\x1b]133;A\x07";

class PromptCountingTerminal extends VirtualTerminal {
	promptStarts = 0;

	override write(data: string): void {
		this.promptStarts += data.split(PROMPT_START).length - 1;
		super.write(data);
	}
}

describe("user bubble prompt zones across repaints", () => {
	// #17307: a terminal drops a working/blocked OSC 7501 record at every 133;A and
	// may announce the drop as a finished command, so while the host holds such a
	// record no redraw or resize may write a prompt start.
	it("writes no prompt start on redraws while zones are off, and restores the zone once they are back on", async () => {
		const terminal = new PromptCountingTerminal(80, 8);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const messages = [new UserMessageComponent("Run sleep 15"), new UserMessageComponent("and then?")];
		tui.setFrameProvider({
			renderFrame: size => ({ viewport: [...messages.flatMap(m => m.render(size.columns)), "status"] }),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(terminal);
			expect(terminal.promptStarts).toBe(2);

			setPromptZonesEnabled(false);
			tui.requestRender();
			await scheduler.settle(terminal);
			const before = terminal.promptStarts;
			for (let i = 0; i < 3; i++) {
				tui.requestRender(true);
				await scheduler.settle(terminal);
			}
			terminal.resize(70, 8);
			await scheduler.advance(terminal, 180);
			expect(terminal.promptStarts).toBe(before);

			setPromptZonesEnabled(true);
			tui.requestRender();
			await scheduler.settle(terminal);
			expect(terminal.promptStarts).toBe(before + 2);
			tui.requestRender();
			await scheduler.settle(terminal);
			expect(terminal.promptStarts).toBe(before + 2);
		} finally {
			setPromptZonesEnabled(true);
			tui.stop();
		}
	});
});

it("copies the exact submitted prompt from the right end of the bubble's bottom row", () => {
	const source = "**first**\n\tsecond [Image #1, 20x20]";
	const payloads: string[] = [];
	applyHyperlinkSetting("always");
	setCopyUrlTargetProvider(text => {
		payloads.push(text);
		return "omp-copy:user-prompt";
	});
	const prompt = new UserMessageComponent(source);
	const width = 50;
	try {
		setCopyUrlHandlerReady(false);
		const withoutCopy = prompt.render(width);
		expect(withoutCopy.at(-1)).not.toContain("omp-copy:");

		setCopyUrlHandlerReady(true);
		const rows = prompt.render(width);
		expect(rows).toHaveLength(withoutCopy.length);
		expect(rows.at(-1)).toContain("omp-copy:user-prompt");
		expect(stripTerminalSequences(rows.at(-1)!)).toBe(`${" ".repeat(width - 7)}[copy] `);
		expect(payloads).toEqual([source]);

		applyHyperlinkSetting("off");
		expect(prompt.render(width).at(-1)).not.toContain("omp-copy:");
	} finally {
		setCopyUrlHandlerReady(false);
		setCopyUrlTargetProvider(undefined);
		applyHyperlinkSetting("auto");
	}
});

it("offers native prompt copy after the message and sends its source to the clipboard handler", () => {
	const source = "Compare [Image #1, 20x20]\n**with this**";
	const actions: TranscriptAction[] = [];
	setTranscriptActionHandler(action => actions.push(action));
	try {
		const prompt = new UserMessageComponent(source);
		const footer = prompt.describe().c?.at(-1);
		expect(footer && "k" in footer && footer.k === "row" && footer.p?.justify).toBe("end");
		const icon = footer && "k" in footer ? footer.c?.at(-1) : undefined;
		if (!icon || !("k" in icon) || icon.k !== "icon" || !icon.p?.actions?.click) {
			throw new Error("Missing native copy action at the bottom of the prompt");
		}
		prompt.handleNativeEvent({ type: "action", act: icon.p.actions.click, key: "copy-footer/copy", mods: [] });
		expect(actions).toEqual([{ act: "copy", text: source }]);
	} finally {
		setTranscriptActionHandler(undefined);
	}
});
