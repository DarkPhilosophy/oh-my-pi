import { QrCode, renderQrHalfBlocks } from "../chrome/qrcode";
import { fileUriForTerminal, uriHyperlink } from "../render/hyperlink";
import { TERMINAL } from "../terminal-capabilities";
import type { ImageTheme } from "./image";

interface QrTile {
	columns: number;
	lines: readonly string[];
}

/** A local-link placeholder; symbols and their quiet zones are never clipped. */
export class ImagePlaceholder {
	static #nextNoiseSeed = 0;
	readonly #noiseSeed: number;
	#qrCache?: { target: string; maxVersion: number; tile?: QrTile };

	constructor(imageKey?: string) {
		this.#noiseSeed = imageKey === undefined ? ++ImagePlaceholder.#nextNoiseSeed : Bun.hash.xxHash32(imageKey);
	}

	#qrTile(target: string | undefined, maxVersion: number): QrTile | undefined {
		if (!target || maxVersion < 1) return undefined;
		const cached = this.#qrCache;
		if (cached?.target === target) {
			if (cached.tile) return cached.tile.columns <= 25 + maxVersion * 4 ? cached.tile : undefined;
			if (cached.maxVersion >= maxVersion) return undefined;
		}
		let tile: QrTile | undefined;
		try {
			const qr = QrCode.encodeText(target, "M", { maxVersion });
			tile = { columns: qr.size + 8, lines: renderQrHalfBlocks(qr, { margin: 4 }) };
		} catch (error) {
			if (!(error instanceof Error) || !error.message.startsWith("data too long for a QR code")) throw error;
		}
		this.#qrCache = { target, maxVersion, tile };
		return tile;
	}

	render(columns: number, rows: number, filePath: string | undefined, theme: ImageTheme): string[] {
		const target = filePath ? fileUriForTerminal(filePath, undefined, TERMINAL.id) : undefined;
		const framed = columns >= 3 && rows >= 3;
		const innerWidth = framed ? columns - 2 : columns;
		const innerHeight = framed ? rows - 2 : rows;
		const center = Math.floor((rows - 1) / 2);
		const boxed = framed && innerWidth >= 5 && innerHeight >= 3;
		const label = (boxed ? innerWidth - 4 : innerWidth) >= 13 ? "Click To Open" : "▧";
		const labelWidth = Bun.stringWidth(label);
		const boxWidth = boxed ? labelWidth + 4 : labelWidth;
		const boxLeft = Math.floor((innerWidth - boxWidth) / 2);
		const boxTop = center - 2;
		const linked = target ? uriHyperlink(target, label) : label;
		// Coordinate-based grain stays still across redraws, resizes and history replay.
		// Only uncovered cells are filled, so QR quiet zones remain untouched.
		const noise = (start: number, end: number, y: number): string => {
			let text = "";
			for (let x = start; x < end; x++) {
				if (boxed && x >= boxLeft - 1 && x <= boxLeft + boxWidth && y >= boxTop - 1 && y <= boxTop + 3) {
					text += " ";
					continue;
				}
				let hash = Math.imul(x + this.#noiseSeed, 374761393) ^ Math.imul(y + this.#noiseSeed, 668265263);
				hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
				hash ^= hash >>> 16;
				const dots = hash & (hash >>> 8) & 0xff || 1 << ((hash >>> 24) & 7);
				text += String.fromCharCode(0x2800 + dots);
			}
			return theme.fallbackColor(text);
		};

		const regions = boxed
			? [
					{ x: 0, y: 0, width: innerWidth, height: boxTop },
					{ x: 0, y: boxTop + 3, width: innerWidth, height: innerHeight - boxTop - 3 },
					{ x: 0, y: 0, width: boxLeft, height: innerHeight },
					{ x: boxLeft + boxWidth, y: 0, width: innerWidth - boxLeft - boxWidth, height: innerHeight },
				]
			: [];
		const moduleLimit = Math.max(0, ...regions.map(region => Math.min(region.width, region.height * 2)));
		const tile = this.#qrTile(target, Math.min(40, Math.floor((moduleLimit - 25) / 4)));
		const placements: { x: number; y: number }[] = [];
		if (tile) {
			const height = tile.lines.length;
			for (const region of regions) {
				const across = Math.floor(region.width / tile.columns);
				const down = Math.floor(region.height / height);
				const startX = region.x + Math.floor((region.width - across * tile.columns) / 2);
				const startY = region.y + Math.floor((region.height - down * height) / 2);
				for (let row = 0; row < down; row++) {
					for (let col = 0; col < across; col++) {
						const x = startX + col * tile.columns;
						const y = startY + row * height;
						if (
							placements.some(
								other =>
									x < other.x + tile.columns &&
									x + tile.columns > other.x &&
									y < other.y + height &&
									y + height > other.y,
							)
						)
							continue;
						placements.push({ x, y });
					}
				}
			}
		}

		const lines: string[] = [];
		for (let row = 0; row < rows; row++) {
			if (framed && (row === 0 || row === rows - 1)) {
				lines.push(
					theme.fallbackColor((row === 0 ? "╭" : "╰") + "─".repeat(innerWidth) + (row === 0 ? "╮" : "╯")) +
						"\x1b[0m",
				);
				continue;
			}
			const y = framed ? row - 1 : row;
			const segments: { column: number; width: number; text: string }[] = [];
			if (tile) {
				for (const placement of placements) {
					if (y >= placement.y && y < placement.y + tile.lines.length) {
						segments.push({ column: placement.x, width: tile.columns, text: tile.lines[y - placement.y]! });
					}
				}
			}
			if (boxed && y >= boxTop && y < boxTop + 3) {
				const text =
					y === boxTop
						? `╭${"─".repeat(labelWidth + 2)}╮`
						: y === boxTop + 2
							? `╰${"─".repeat(labelWidth + 2)}╯`
							: `│ ${linked} │`;
				segments.push({ column: boxLeft, width: boxWidth, text: theme.fallbackColor(text) });
			} else if (!boxed && row === center) {
				segments.push({ column: boxLeft, width: labelWidth, text: theme.fallbackColor(linked) });
			}
			segments.sort((a, b) => a.column - b.column);
			let content = "";
			let column = 0;
			for (const segment of segments) {
				content += noise(column, segment.column, y) + segment.text;
				column = segment.column + segment.width;
			}
			content += noise(column, innerWidth, y);
			lines.push((framed ? theme.fallbackColor("│") + content + theme.fallbackColor("│") : content) + "\x1b[0m");
		}
		return lines;
	}
}
