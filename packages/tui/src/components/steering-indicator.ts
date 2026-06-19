import type { TUI } from "../tui";
import { Text } from "./text";

/**
 * Animated "Steering" indicator rendered AS the top border of the pending
 * streaming-steer box.
 *
 * Visual: a rounded box top rule — `╭─ Steering ──────────────╮` — where the
 * word `Steering` is inset as the box title (exactly like every other titled
 * surface) and a single comet sweeps the whole rule left→right, then bounces
 * back right→left, leaving a fading trail (`● • ∙ ·`) behind it and nothing
 * ahead. Plain rule cells stay `─`; the comet only overlays its trail glyphs as
 * it passes, and the title letters brighten (muted → bold accent) under the
 * comet glow. Monochrome by design: only brightness and glyph size vary, never
 * the hue, and the line keeps a constant visible width every frame so the
 * pending layout never jitters. The owning {@link QueuedMessageBox} renders its
 * body + bottom border only, so the indicator + box read as one framed block
 * with an animated title rule.
 *
 * Package boundary: this lives in `packages/tui` and stays theme-agnostic — the
 * caller injects both the brightness stylers and the border glyphs/paint, so it
 * never imports coding-agent chrome.
 *
 * Lifecycle: self-driving via `setInterval`; the owner MUST call {@link dispose}
 * (or {@link stop}) before dropping the instance — containers `clear()` without
 * disposing children, so a leaked interval would repaint a detached node.
 */

const FRAME_MS = 90;
// Glyph ramp from faint to bold: the comet head shows ●, and the trail behind it
// fades • ∙ · as the distance from the head grows.
const GLYPHS = ["·", "∙", "•", "●"] as const;
const MAX_LEVEL = GLYPHS.length - 1;
// Below this the titled rule has no room; fall back to the bare word so a very
// narrow terminal still shows *something* without breaking layout width.
const MIN_BORDER_WIDTH = 8;

type StyleFns = {
	/** Dim/dark styling for faint particles. */
	dim: (s: string) => string;
	/** Mid styling for the resting title word and the comet's near trail. */
	mid: (s: string) => string;
	/** Bright/bold styling for the comet head (●) and the letter it sweeps under. */
	bright: (s: string) => string;
};

type BorderStyle = {
	/** Top-left corner glyph (e.g. `╭`). */
	topLeft: string;
	/** Top-right corner glyph (e.g. `╮`). */
	topRight: string;
	/** Horizontal rule glyph (e.g. `─`). */
	horizontal: string;
	/** Border color paint for the corners and resting rule cells. */
	paint: (s: string) => string;
};

export class SteeringIndicator extends Text {
	#ui: TUI | null = null;
	#styles: StyleFns;
	#border: BorderStyle;
	#word: string;
	// The comet position along the inner rule and its travel direction. It sweeps
	// the whole rule left→right, then bounces back right→left — one clear sweep at
	// a time (never two simultaneous waves), with a trail fading behind it.
	#pos = 0;
	#dir: 1 | -1 = 1;
	#intervalId?: NodeJS.Timeout;
	#active = false;
	// Last layout width, captured in render(); the animation timer reads it to
	// bounce the comet at the real rule ends.
	#lastWidth = 0;
	#cacheSig = "";
	#cacheLine: readonly string[] | undefined;

	/**
	 * @param ui     TUI for component-scoped redraws.
	 * @param styles dim/mid/bright stylers (hue stays constant; only brightness varies).
	 * @param border box-drawing glyphs + border paint, injected so this stays theme-agnostic.
	 * @param word   the inset title word (default `Steering`).
	 */
	constructor(ui: TUI, styles: StyleFns, border: BorderStyle, word = "Steering") {
		super("", 0, 0);
		this.#ui = ui;
		this.#styles = styles;
		this.#border = border;
		this.#word = word;
	}

	/** Number of inner rule cells the comet sweeps (between the two corners). */
	#span(): number {
		return Math.max(1, this.#lastWidth - 2);
	}

	/** Activate (animate) or deactivate (stop + show a static idle rule). Idempotent. */
	setActive(active: boolean): void {
		if (active) {
			if (this.#intervalId) return;
			this.#active = true;
			this.#invalidateFrame();
			this.#intervalId = setInterval(() => {
				// Sweep the comet one cell in the current direction; reverse at each end so
				// it travels left→right then right→left (a single clear sweep each way).
				const span = this.#span();
				const next = this.#pos + this.#dir;
				if (next >= span - 1) {
					this.#pos = span - 1;
					this.#dir = -1;
				} else if (next <= 0) {
					this.#pos = 0;
					this.#dir = 1;
				} else {
					this.#pos = next;
				}
				this.#invalidateFrame();
				this.#ui?.requestComponentRender(this);
			}, FRAME_MS);
		} else {
			this.stop();
			if (this.#active) {
				this.#active = false;
				this.#invalidateFrame();
				this.#ui?.requestComponentRender(this);
			}
		}
	}

	stop(): void {
		if (this.#intervalId) {
			clearInterval(this.#intervalId);
			this.#intervalId = undefined;
		}
	}

	/** Lifecycle teardown: stop the animation timer. Idempotent. */
	dispose(): void {
		this.stop();
	}

	#invalidateFrame(): void {
		this.#cacheSig = "";
		this.#cacheLine = undefined;
	}

	invalidate(): void {
		super.invalidate();
		this.#invalidateFrame();
	}

	/**
	 * Build the animated top-border line for the current frame. Overrides
	 * {@link Text.render} so the rule spans the full layout width every frame —
	 * the timer only advances the comet and asks the TUI to re-render this node.
	 */
	render(width: number): readonly string[] {
		this.#lastWidth = width;
		const pos = Math.min(Math.max(0, this.#pos), this.#span() - 1);
		const sig = `${width}|${pos}|${this.#dir}|${this.#active ? 1 : 0}`;
		if (this.#cacheLine && this.#cacheSig === sig) return this.#cacheLine;
		const line = this.#buildLine(width, pos);
		this.#cacheLine = [line];
		this.#cacheSig = sig;
		return this.#cacheLine;
	}

	/**
	 * One frame: `╭` + inner rule + `╮`. The inner cells carry the inset title
	 * `␣Steering␣` (after a single leading rule cell, matching the shared
	 * top-border layout) flanked by `─` rule. A comet at `pos` shows `●` and
	 * fades `• ∙ ·` behind it along its travel direction; cells ahead stay plain.
	 * Title letters brighten under the comet, rest in mid. Constant visible width.
	 */
	#buildLine(width: number, pos: number): string {
		const { topLeft, topRight, horizontal, paint } = this.#border;
		if (width < MIN_BORDER_WIDTH) {
			return this.#active ? this.#styles.bright(this.#word) : this.#styles.mid(this.#word);
		}
		const inner = width - 2;
		// Title inset one rule cell in from the left corner: `╭─ Steering ─…─╮`.
		const titleStr = ` ${this.#word} `;
		const titleStart = 1;
		const titleEnd = Math.min(inner, titleStart + titleStr.length); // exclusive
		let out = paint(topLeft);
		for (let c = 0; c < inner; c++) {
			// Trail distance: how far this cell sits *behind* the comet along its
			// travel direction (0 at the head; positive behind; negative ahead).
			const behind = this.#dir > 0 ? pos - c : c - pos;
			const level = this.#active && behind >= 0 && behind <= MAX_LEVEL ? MAX_LEVEL - behind : -1;
			if (c >= titleStart && c < titleEnd) {
				const ch = titleStr[c - titleStart] ?? " ";
				if (ch === " ") {
					// Title margin stays clean; only the comet head crosses it visibly.
					out += level >= MAX_LEVEL ? this.#styles.bright(GLYPHS[MAX_LEVEL]) : " ";
				} else {
					// Only the single letter directly under the comet head brightens; the
					// rest of the word rests in mid, so exactly one cell glows per frame.
					out += level >= MAX_LEVEL ? this.#styles.bright(ch) : this.#styles.mid(ch);
				}
			} else if (level >= MAX_LEVEL) {
				out += this.#styles.bright(GLYPHS[MAX_LEVEL]);
			} else if (level >= 0) {
				out += this.#styles.mid(GLYPHS[level]);
			} else {
				out += paint(horizontal);
			}
		}
		out += paint(topRight);
		return out;
	}
}
