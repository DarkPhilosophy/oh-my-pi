import { wrapTextWithAnsi } from "../utils";

/** Result of {@link tailLinesWithinVisualRows}. */
export interface VisualTail {
	/** Index of the first logical line kept. */
	start: number;
	/** Physical rows the kept lines occupy at the requested width. */
	rows: number;
}

/**
 * Select the trailing logical lines whose wrapped height fits `rowLimit`
 * physical rows at `width`.
 *
 * A window sized in logical lines changes height whenever a wrapping line
 * enters or leaves it, so a streaming preview swings between short and tall.
 * Counting physical rows keeps the window height stable. One logical line may
 * exceed the budget on its own; it is still kept so the newest line is visible.
 * Without wrapping this degenerates to the last `rowLimit` logical lines.
 *
 * `measure` returns the physical rows of one line; the default wraps it at
 * `width`, and callers whose rows carry a gutter pass a narrower width.
 */
export function tailLinesWithinVisualRows(
	lines: readonly string[],
	rowLimit: number,
	width: number,
	measure: (line: string, width: number) => number = defaultMeasure,
): VisualTail {
	const limit = Math.max(1, Math.floor(rowLimit));
	let start = lines.length;
	let rows = 0;
	for (let index = lines.length - 1; index >= 0; index--) {
		const lineRows = Math.max(1, measure(lines[index]!, width));
		if (rows > 0 && rows + lineRows > limit) break;
		rows += lineRows;
		start = index;
	}
	return { start, rows };
}

function defaultMeasure(line: string, width: number): number {
	return wrapTextWithAnsi(line, Math.max(1, width)).length;
}
