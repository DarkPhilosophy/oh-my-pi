/**
 * Right-side info panel compositing: floats panel blocks into the trailing
 * whitespace ("negative space") of rendered rows. Never overwrites visible
 * text — a block only lands on a run of rows whose content stays left of the
 * panel column — and hides entirely when there is no room.
 *
 * The TUI engine consumes the range form at the window stage of a frame
 * (after the window/commit math), where the visible viewport is known
 * exactly. Compositing there cannot touch rows committed to native
 * scrollback and does not interfere with the live-region / stable-prefix
 * protocol, because the composed frame itself is never mutated.
 */
import { padding, truncateToWidth, visibleWidth } from "./utils";

const TRAILING_PADDING_RE = /[ \t]+((?:\x1b\[[0-9;]*m)*)$/u;

/** Strip trailing whitespace padding from a line, keeping trailing SGR sequences. */
export function trimRightPadding(line: string): string {
	// Hot path: a trailing-padding match always ends in a space, tab, or the
	// `m` that terminates an SGR sequence, so bail cheaply otherwise.
	const last = line.charCodeAt(line.length - 1);
	if (last !== 0x20 && last !== 0x09 && last !== 0x6d) return line;
	return line.replace(TRAILING_PADDING_RE, "$1");
}

/** Fewer eligible rows than this hides the panel: too cramped to be useful. */
export const RIGHT_PANEL_MIN_ROWS = 6;
/** A panel column left of this hides the block: the terminal is too narrow. */
const RIGHT_PANEL_MIN_COL = 30;

/**
 * Composite a single right-side panel into the trailing whitespace of
 * `baseLines`. Pure: returns the merged lines, or `baseLines` unchanged
 * (same reference) when the panel does not fit within the bottom
 * `viewportHeight` rows.
 */
export function compositeRightPanel(
	baseLines: string[],
	widget: readonly string[],
	width: number,
	viewportHeight: number,
	isImageLine: (line: string) => boolean = () => false,
): string[] {
	return compositeRightPanels(baseLines, widget.length > 0 ? [widget] : [], width, viewportHeight, isImageLine);
}

/**
 * Composite multiple right-side panel blocks into the trailing whitespace of
 * `baseLines`, each one independently, searching the bottom `viewportHeight`
 * rows. Blocks are placed in the given order (the caller pre-sorts by
 * priority): each block claims the first free run of negative space tall
 * enough for it, those rows are then marked occupied, and a block that finds
 * no run is dropped on its own — the others still render. Pure: returns
 * merged lines, or `baseLines` unchanged (same reference) when nothing fits.
 * Never overwrites visible text or a terminal image block.
 */
export function compositeRightPanels(
	baseLines: string[],
	blocks: readonly (readonly string[])[],
	width: number,
	viewportHeight: number,
	isImageLine: (line: string) => boolean = () => false,
): string[] {
	return compositeRightPanelsInRange(
		baseLines,
		blocks,
		width,
		Math.max(0, baseLines.length - viewportHeight),
		baseLines.length,
		isImageLine,
	);
}

/**
 * Range form: composite blocks only into rows of `[searchStart, searchEnd)`.
 * The engine uses this with the window rows owned by the registered target
 * roots, so a panel can never land on bottom chrome (editor, status line).
 *
 * Trailing padding (full-width styled backgrounds) is ignored when measuring
 * free space, but only rows that actually receive panel text are re-written
 * with the padding stripped — untouched rows keep their styling byte-exact.
 */
export function compositeRightPanelsInRange(
	baseLines: string[],
	blocks: readonly (readonly string[])[],
	width: number,
	searchStart: number,
	searchEnd: number,
	isImageLine: (line: string) => boolean = () => false,
): string[] {
	if (blocks.length === 0 || baseLines.length === 0) return baseLines;
	searchStart = Math.max(0, searchStart);
	searchEnd = Math.min(baseLines.length, searchEnd);
	if (searchEnd - searchStart < RIGHT_PANEL_MIN_ROWS) return baseLines;

	// Terminal image components render as (rows-1) blank placeholder lines
	// followed by a raw protocol escape line. Those blanks look free to
	// visibleWidth() but are visually covered by the image, so mark the whole
	// block occupied and never splice a panel into it.
	const occupied = new Array<boolean>(baseLines.length).fill(false);
	for (let i = 0; i < baseLines.length; i++) {
		if (isImageLine(baseLines[i] ?? "")) {
			occupied[i] = true;
			for (let j = i - 1; j >= 0 && visibleWidth(baseLines[j] ?? "") === 0; j--) occupied[j] = true;
		}
	}

	// Content width with trailing padding ignored, computed lazily per row.
	const freeWidthCache: (number | undefined)[] = new Array(baseLines.length);
	const contentWidth = (row: number): number => {
		let w = freeWidthCache[row];
		if (w === undefined) {
			w = visibleWidth(trimRightPadding(baseLines[row] ?? ""));
			freeWidthCache[row] = w;
		}
		return w;
	};

	const placements: { start: number; block: readonly string[]; col: number }[] = [];
	for (const block of blocks) {
		if (block.length === 0) continue;
		let panelWidth = 0;
		for (const line of block) panelWidth = Math.max(panelWidth, visibleWidth(line));
		const col = width - panelWidth - 1; // 1-col gap from the panel
		if (col < RIGHT_PANEL_MIN_COL) continue; // too narrow for this block — hide just this one
		let placed = -1;
		for (let start = searchStart; start + block.length <= searchEnd; start++) {
			let ok = true;
			for (let k = 0; k < block.length; k++) {
				if (occupied[start + k] || contentWidth(start + k) > col) {
					ok = false;
					break;
				}
			}
			if (ok) {
				placed = start;
				break;
			}
		}
		if (placed < 0) continue; // no run tall enough — drop this block alone
		for (let k = 0; k < block.length; k++) occupied[placed + k] = true;
		placements.push({ start: placed, block, col });
	}

	if (placements.length === 0) return baseLines;

	const out = baseLines.slice();
	for (const { start, block, col } of placements) {
		for (let k = 0; k < block.length; k++) {
			const base = trimRightPadding(out[start + k] ?? "");
			const truncatedBase = truncateToWidth(base, col);
			// If the base row carries color state, terminate it so the gap padding and
			// the panel do not inherit an unclosed SGR sequence.
			const reset = truncatedBase.includes("\x1b[") ? "\x1b[0m" : "";
			out[start + k] = truncatedBase + reset + padding(Math.max(0, col - visibleWidth(base))) + block[k];
		}
	}
	return out;
}
