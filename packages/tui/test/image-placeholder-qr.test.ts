import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import * as url from "node:url";
import { Image, ImageBudget, renderForScrollback } from "../src/components/image";
import { QrCode, renderQrHalfBlocks } from "../src/chrome/qrcode";
import { applyHyperlinkSetting } from "../src/render/hyperlink";
import { getCellDimensions, ImageProtocol, setCellDimensions, TERMINAL } from "../src/terminal-capabilities";
import { getKittyGraphics, setKittyGraphics } from "../src/kitty-graphics";
import { VirtualTerminal } from "./virtual-terminal";
import { CURSOR_MARKER, TUI } from "../src/tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";
const terminal = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };

function makeImage(columns: number, rows: number, source: string, budget?: ImageBudget, imageKey?: string): Image {
	return new Image(
		PNG,
		"image/png",
		{ fallbackColor: text => `\x1b[2m${text}\x1b[22m` },
		{ sourcePath: source, filename: "preview.png", maxWidthCells: columns, maxHeightCells: rows, budget, imageKey },
		{ widthPx: columns * 10, heightPx: rows * 10 },
	);
}

function findTiles(plain: readonly string[], tile: readonly string[]): { x: number; y: number }[] {
	const placements: { x: number; y: number }[] = [];
	const width = tile[0]!.length;
	for (let y = 1; y + tile.length < plain.length; y++) {
		let x = plain[y + 2]!.indexOf(tile[2]!, 1);
		while (x >= 0) {
			if (
				x + width < plain[y]!.length &&
				tile.every((row, index) => plain[y + index]!.slice(x, x + width) === row)
			) {
				placements.push({ x, y });
			}
			x = plain[y + 2]!.indexOf(tile[2]!, x + 1);
		}
	}
	return placements;
}

describe("local image QR placeholder", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCells = getCellDimensions();
	beforeEach(() => {
		originalCells = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = null;
		setKittyGraphics({ unicodePlaceholders: false });
		applyHyperlinkSetting("always");
	});
	afterEach(() => {
		setCellDimensions(originalCells);
		terminal.imageProtocol = originalProtocol;
		setKittyGraphics(originalGraphics);
		applyHyperlinkSetting("auto");
	});

	it.each([
		{ name: "text", protocol: null },
		{ name: "kitty", protocol: ImageProtocol.Kitty },
	])("keeps the centered opening box inside the image footprint ($name)", ({ protocol }) => {
		terminal.imageProtocol = protocol;
		const source = path.resolve("preview.png");
		const budget = new ImageBudget(1);
		const image = makeImage(60, 12, source, budget);
		const lines = image.render(62);
		const output = budget.takeTransmits().join("") + lines.join("\r\n") + "\r\nAFTER";
		const textOnly = new VirtualTerminal(62, 20);
		textOnly.write(output.replace(/\x1b_G[\s\S]*?\x1b\\/g, ""));
		const visible = textOnly.getViewport();
		expect(lines).toHaveLength(12);
		expect(visible[0]!.trimEnd()).toBe(`╭${"─".repeat(58)}╮`);
		expect(visible[11]!.trimEnd()).toBe(`╰${"─".repeat(58)}╯`);
		const center = visible.findIndex(line => line.includes("Click To Open"));
		expect(Math.abs(center - 5.5)).toBeLessThanOrEqual(0.5);
		const left = visible[center]!.indexOf("Click To Open");
		expect(Math.abs(left - (60 - 13) / 2)).toBeLessThanOrEqual(0.5);
		expect(visible[center - 1]!.slice(left - 2, left + 15)).toBe(`╭${"─".repeat(15)}╮`);
		expect(visible[center]!.slice(left - 2, left + 15)).toBe("│ Click To Open │");
		expect(visible[center + 1]!.slice(left - 2, left + 15)).toBe(`╰${"─".repeat(15)}╯`);
		expect(lines[center]).toContain(url.pathToFileURL(source).href);
		expect(visible.findIndex(line => line.includes("AFTER"))).toBe(12);
		expect(visible.slice(0, 12).join("")).not.toMatch(/[▀▄█]/u);
		for (let y = 1; y < 11; y++) {
			expect(visible[y]!.slice(1, left - 4)).toMatch(/^[\u2801-\u28ff]+$/u);
			expect(visible[y]!.slice(left + 17, 59)).toMatch(/^[\u2801-\u28ff]+$/u);
		}
		expect(visible[center]!.slice(left - 3, left - 2)).toBe(" ");
		expect(visible[center]!.slice(left + 15, left + 16)).toBe(" ");
		image.invalidate();
		expect(image.render(62)).toEqual(lines);
		if (protocol === ImageProtocol.Kitty) {
			const graphical = new VirtualTerminal(62, 20);
			graphical.write(output);
			const placements = graphical.graphicsPlacements();
			expect(placements).toHaveLength(1);
			expect(placements[0]!.zIndex).toBeGreaterThanOrEqual(0);
			expect(placements[0]!.numRows).toBe(12);
			expect(placements[0]!.numCols).toBe(60);
		}
	});

	it("tiles complete local-link codes without cutting quiet zones or covering the opening box", () => {
		const source = path.resolve("fixtures", "local preview-ș.png");
		const target = url.pathToFileURL(source).href;
		const image = makeImage(200, 100, source);
		const lines = image.render(202).slice();
		const plain = lines.map(line => Bun.stripANSI(line));
		const qr = QrCode.encodeText(target, "M");
		const tile = renderQrHalfBlocks(qr);
		const tileWidth = qr.size + 8;
		const placements = findTiles(
			plain,
			tile.map(line => Bun.stripANSI(line)),
		);
		expect(placements.length).toBeGreaterThan(1);
		const center = plain.findIndex(line => line.includes("Click To Open"));
		const panelLeft = plain[center]!.indexOf("Click To Open") - 2;
		for (const placement of placements) {
			expect(
				placement.x + tileWidth <= panelLeft ||
					placement.x >= panelLeft + 17 ||
					placement.y + tile.length <= center - 1 ||
					placement.y > center + 1,
			).toBe(true);
		}
		const uncovered: string[] = [];
		for (let y = 0; y < plain.length; y++) {
			for (let x = 0; x < plain[y]!.length; x++) {
				if (
					/[▀▄█]/u.test(plain[y]![x]!) &&
					!placements.some(p => x >= p.x && x < p.x + tileWidth && y >= p.y && y < p.y + tile.length)
				) {
					uncovered.push(`${x}:${y}`);
				}
			}
		}
		expect(uncovered).toEqual([]);
		const viewport = new VirtualTerminal(202, 102);
		viewport.write(lines.join("\r\n"));
		const first = placements[0]!;
		expect(viewport.getCellDim(first.y + 2, first.x + 4)).toBe(false);
		for (let y = 1; y < plain.length - 1; y++) {
			for (let x = 1; x < plain[y]!.length - 1; x++) {
				if (/[\u2801-\u28ff]/u.test(plain[y]![x]!)) expect(viewport.getCellDim(y, x)).toBe(true);
			}
		}
		image.invalidate();
		expect(image.render(202)).toEqual(lines);
		image.render(62);
		image.releaseRenderCaches();
		expect(renderForScrollback(() => image.render(202))).toEqual(lines);
		expect(makeImage(200, 100, source).render(202)).not.toEqual(lines);
		expect(plain.join("")).toMatch(/[\u2801-\u28ff]/u);
	});

	it("keeps grain stable when streaming reconstructs the same image occurrence", () => {
		const source = path.resolve("preview.png");
		const first = makeImage(60, 12, source, undefined, "read:first:0").render(62);
		expect(makeImage(60, 12, source, undefined, "read:first:0").render(62)).toEqual(first);
		expect(makeImage(60, 12, source, undefined, "read:second:0").render(62)).not.toEqual(first);
	});

	it.each([1, 2])("keeps tiny %i-cell images clickable without adding rows", size => {
		const source = path.resolve("tiny.png");
		const lines = makeImage(size, size, source).render(size + 2);
		expect(lines).toHaveLength(size);
		expect(Bun.stripANSI(lines.join(""))).toContain("▧");
		expect(lines.join("")).toContain(url.pathToFileURL(source).href);
		for (const line of lines) expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(size);
	});

	it("bounds unlinked metadata by terminal width without wrapping into the next row", () => {
		applyHyperlinkSetting("off");
		const image = new Image(
			PNG,
			"image/png",
			{ fallbackColor: text => text },
			{ filename: "long-name-".repeat(20), maxWidthCells: 4, maxHeightCells: 4 },
			{ widthPx: 100, heightPx: 100 },
		);
		const lines = image.render(20);
		expect(lines.join("")).toContain("[Image:");
		expect(Bun.stringWidth(Bun.stripANSI(lines.join("")))).toBeLessThanOrEqual(20);
		const terminalText = new VirtualTerminal(20, 4);
		terminalText.write(lines.join("\r\n") + "\r\nAFTER");
		expect(terminalText.getViewport()[1]).toStartWith("AFTER");
	});
	it("renders one complete QR when only one tile fits beside the opening box", () => {
		const source = "/qr.png";
		const lines = makeImage(40, 34, source)
			.render(42)
			.map(line => Bun.stripANSI(line));
		const tile = renderQrHalfBlocks(QrCode.encodeText(url.pathToFileURL(source).href, "M")).map(line =>
			Bun.stripANSI(line),
		);
		expect(findTiles(lines, tile)).toHaveLength(1);
		expect(lines.join("\n")).toContain("Click To Open");
	});

	it("retains the opening link when its target exceeds the available QR capacity", () => {
		const source = path.resolve("é".repeat(1000) + ".png");
		const lines = makeImage(200, 100, source).render(202);
		expect(lines).toHaveLength(100);
		expect(lines.join("")).toContain(url.pathToFileURL(source).href);
		expect(Bun.stripANSI(lines.join(""))).not.toMatch(/[▀▄█]/u);
		for (const line of lines) expect(Bun.stringWidth(Bun.stripANSI(line))).toBe(200);
	});

	it("clears QR underlays for a cursor popup and restores them without changing image geometry", async () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const term = new VirtualTerminal(80, 50);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, false, { renderScheduler: scheduler });
		const image = makeImage(60, 60, "/qr.png", tui.imageBudget);
		tui.setFrameProvider({
			renderFrame: size => ({ viewport: [...image.render(size.columns), `${CURSOR_MARKER}AFTER`] }),
			acknowledgeHistory() {},
			beginHistoryReplay() {},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			const before = term.getViewport();
			expect(before.join("\n")).toMatch(/[▀▄█]/u);
			expect(term.graphicsPlacements()).toHaveLength(1);
			tui.setCursorOverlay(() => ["MENU", "CONTROL"], 0, 1, "above", { col: 5, width: 20 });
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.getViewport().join("\n")).toContain("MENU");
			expect(term.getViewport().join("\n")).not.toMatch(/[▀▄█]/u);
			expect(term.graphicsPlacements().every(placement => placement.zIndex < 0)).toBe(true);
			tui.setCursorOverlay(undefined, 0, 0);
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.getViewport()).toEqual(before);
			expect(term.graphicsPlacements()).toHaveLength(1);
			expect(term.graphicsPlacements()[0]!.zIndex).toBeGreaterThanOrEqual(0);
		} finally {
			tui.stop();
		}
	});

	it("does not emit local QR targets when hyperlinks are disabled", () => {
		const image = makeImage(200, 100, path.resolve("preview.png"));
		image.render(202);
		applyHyperlinkSetting("off");
		const lines = image.render(202);
		expect(lines.join("")).not.toContain("\x1b]8;");
		expect(Bun.stripANSI(lines.join(""))).not.toMatch(/[▀▄█]/u);
		expect(Bun.stripANSI(lines.join(""))).toContain("Click To Open");
	});
});
