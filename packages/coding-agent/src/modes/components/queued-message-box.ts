import type { Component } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";
import { bottomBorder, fit, row, topBorder } from "./overlay-box";

/**
 * A single queued steer / follow-up message rendered inside a bordered box.
 *
 * The label (`Steer` / `Follow-up`) is inset into the top rule as the box title,
 * and each message line sits on its own row inside the frame. The frame makes a
 * long expanded message (Alt+O on a 10+ line entry) read as one self-contained
 * block instead of a wall of indented rows bleeding into the hint.
 *
 * Rendering is deferred to {@link render} because the box width is only known at
 * paint time (the pending container's column count); the shared `overlay-box`
 * helpers paint the border with the same `theme.boxSharp` glyphs and `border`
 * color as every other outlined surface, so it reads identically.
 */
export class QueuedMessageBox implements Component {
	#title: string;
	#lines: readonly string[];
	#suffix: string;
	#showTopBorder: boolean;
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	/**
	 * @param title  Box title inset into the top rule (e.g. `Steer`, `Follow-up`).
	 * @param lines  The message lines to show (already sanitized; tabs expanded,
	 *               control chars stripped by the caller).
	 * @param suffix Optional trailing marker for the last row (e.g. `(+3)` when
	 *               collapsed with hidden lines); empty when expanded/short.
	 * @param showTopBorder When false, the box omits its own top rule — the caller
	 *               supplies it instead (the animated {@link SteeringIndicator}
	 *               renders the live steer box's title rule). Body rows + bottom
	 *               border still align column-for-column with that external rule.
	 */
	constructor(title: string, lines: readonly string[], suffix = "", showTopBorder = true) {
		this.#title = title;
		this.#lines = lines;
		this.#suffix = suffix;
		this.#showTopBorder = showTopBorder;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	render(width: number): readonly string[] {
		if (this.#cachedLines && this.#cachedWidth === width) return this.#cachedLines;
		// A box needs room for two border columns plus a one-column inset each side
		// (overlay-box `row` reserves width-4 for content). Below that, skip the frame
		// and fall back to plain indented rows so the pending bar never breaks on a
		// very narrow terminal.
		if (width < 8) {
			// Plain indented rows; keep the `Label:` lead only when there is a title
			// (the streaming-steer box has none — its title rule lives on the indicator).
			const flat = this.#title
				? [theme.fg("dim", `${this.#title}:`), ...this.#lines.map(l => theme.fg("dim", `  ${l}`))]
				: this.#lines.map(l => theme.fg("dim", `  ${l}`));
			this.#cachedWidth = width;
			this.#cachedLines = flat;
			return flat;
		}
		const out: string[] = this.#showTopBorder ? [topBorder(width, this.#title)] : [];
		const last = this.#lines.length - 1;
		for (let i = 0; i < this.#lines.length; i++) {
			const text = i === last && this.#suffix ? `${this.#lines[i]}${this.#suffix}` : this.#lines[i];
			out.push(row(theme.fg("dim", fit(text, Math.max(0, width - 4))), width));
		}
		if (this.#lines.length === 0) out.push(row("", width));
		out.push(bottomBorder(width));
		this.#cachedWidth = width;
		this.#cachedLines = out;
		return out;
	}
}
