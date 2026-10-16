import { beforeAll, expect, it, vi } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { ManualScheduler, TspTestTerminal } from "./native/tsp-harness";
import { isNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { VirtualTerminal } from "./virtual-terminal";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { ImageProtocol, setTerminalImageProtocol, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";

withoutTerminalMultiplexer();
beforeAll(() => initTheme());

/** Feed the relay's actual non-TSP byte stream into the terminal emulator. */
class RelayedVirtualTerminal extends TspTestTerminal {
	readonly grid = new VirtualTerminal(100, 40);
	constructor(relayed: boolean) {
		super({ cols: 100, rows: 40, relayed, reply: relayed });
	}
	override write(data: string): void {
		const start = this.rowBytes.length;
		super.write(data);
		this.grid.write(this.rowBytes.slice(start));
	}
}

it.each([false, true])("modal ownership is independent of the chat layout (dual=%s)", async relayed => {
	const terminal = new RelayedVirtualTerminal(relayed);
	const scheduler = new ManualScheduler();
	const settle = () => scheduler.flush(100, () => terminal.answerProbe() || terminal.deliver());
	const composer = new Composer({
		terminal,
		preferences: { quiet: true },
		tuiOptions: { renderScheduler: scheduler },
	});
	const transcript = new TranscriptContainer();
	const history = {
		commitToHistoryOnFinalize: true,
		render: () => Array.from({ length: 60 }, (_, index) => `HISTORY_${index}`),
	};
	transcript.addChild(history);
	composer.setRuntimeChildren([transcript, new Text("TODO_HUD\nJOB_HUD", 0, 0), new Text("EDITOR", 0, 0)]);
	composer.start({ playWelcomeIntro: false });
	const screen = () => terminal.grid.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	try {
		settle();
		expect(isNativeRendering()).toBe(relayed);
		expect(transcript.blockStates()).toEqual(["committed"]);
		const before = screen();
		const tapeBefore = terminal.grid.getScrollBuffer();
		const handle = composer.ui.showOverlay(new Text("MODAL_TITLE\nMODAL_BODY", 0, 0), {
			anchor: "center",
			width: "50%",
		});
		settle();
		const open = screen();
		expect(open.some(row => row.includes("MODAL_TITLE"))).toBe(true);
		for (const marker of ["TODO_HUD", "JOB_HUD", "EDITOR"]) {
			expect(open.indexOf(marker)).toBe(before.indexOf(marker));
		}
		handle.hide();
		settle();
		expect(screen()).toEqual(before);
		expect(terminal.grid.getScrollBuffer()).toEqual(tapeBefore);
	} finally {
		composer.stop();
	}
});

it.each([
	{ relayed: false, late: false, settled: false },
	{ relayed: true, late: false, settled: false },
	{ relayed: false, late: true, settled: false },
	{ relayed: true, late: true, settled: false },
	{ relayed: false, late: true, settled: true },
	{ relayed: true, late: true, settled: true },
])("grouped image reads reach ANSI graphics after asynchronous conversion (%o)", async ({ relayed, late, settled }) => {
	const source = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
	const png = await new Bun.Image(Buffer.from(source, "base64"))
		.resize(1568, 995 + Number(relayed) + Number(late) * 2 + Number(settled) * 4)
		.png()
		.toBase64();
	const webp = await new Bun.Image(Buffer.from(png, "base64")).webp().toBase64();
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	setTerminalImageProtocol(ImageProtocol.Kitty);
	setKittyGraphics({ unicodePlaceholders: true });
	const conversion = Promise.withResolvers<string>();
	const updated = Promise.withResolvers<void>();
	const encode = vi.spyOn(Bun.Image.prototype, "toBase64").mockReturnValue(conversion.promise);
	const terminal = new RelayedVirtualTerminal(relayed);
	const scheduler = new ManualScheduler();
	const settle = () => scheduler.flush(100, () => terminal.answerProbe() || terminal.deliver());
	const composer = new Composer({
		terminal,
		preferences: { quiet: true },
		tuiOptions: { renderScheduler: scheduler },
	});
	const transcript = new TranscriptContainer();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "image-read", name: "read", arguments: { path: "fixture.webp" } }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fixture",
		stopReason: "stop",
		timestamp: 0,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	if (settled) message.content.unshift({ type: "text", text: "IMAGE_OWNER_TEXT" });
	const assistant = new AssistantMessageComponent(
		message,
		false,
		() => {
			updated.resolve();
			composer.ui.requestRender();
		},
		[],
		composer.ui.imageBudget,
	);
	const group = new ReadToolGroupComponent({ showContentPreview: true });
	for (let index = 0; index < 3; index++) group.updateArgs({ path: `fixture-${index}.webp` }, `image-${index}`);
	let imageOwner = assistant;
	const finishReads = () => {
		for (let index = 0; index < 3; index++) {
			const id = `image-${index}`;
			imageOwner.setToolResultImages(id, [{ type: "image", data: webp, mimeType: "image/webp" }]);
			group.updateResult({ content: [{ type: "text", text: `READ_IMAGE_${index}` }] }, false, id);
		}
		group.finalize();
	};
	assistant.markTranscriptBlockFinalized();
	if (!late) finishReads();
	transcript.addChild(assistant);
	transcript.addChild(group);
	composer.setRuntimeChildren([transcript, new Text("EDITOR", 0, 0)]);
	try {
		composer.start({ playWelcomeIntro: false });
		settle();
		if (late) {
			expect(transcript.isBlockInLiveRegion(assistant)).toBe(settled);
			if (!settled) {
				imageOwner = assistant.createToolResultImageContinuation();
				transcript.insertChildAt(imageOwner, 1);
			}
			finishReads();
			composer.ui.requestRender();
			settle();
		}
		conversion.resolve(png);
		await updated.promise;
		settle();
		const commands = [...terminal.rowBytes.matchAll(/\x1b_G([^;]*);/g)].map(
			match => new URLSearchParams(match[1]!.replaceAll(",", "&")),
		);
		const transmitted = new Set(commands.filter(params => params.get("a") === "t").map(params => params.get("i")));
		const placed = new Set(commands.filter(params => params.get("a") === "p").map(params => params.get("i")));
		expect(transmitted.size).toBe(3);
		expect(placed).toEqual(transmitted);
		expect(terminal.grid.getScrollBuffer().join("\n")).toContain("READ_IMAGE_2");
	} finally {
		conversion.resolve(png);
		encode.mockRestore();
		composer.stop();
		assistant.dispose();
		if (imageOwner !== assistant) imageOwner.dispose();
		setTerminalImageProtocol(originalProtocol);
		setKittyGraphics(originalGraphics);
	}
});
