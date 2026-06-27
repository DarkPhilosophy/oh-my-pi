import type { TUI } from "../tui";
import { Text } from "./text";

/**
 * Animated "Steering" indicator rendered AS the top border of the pending
 * streaming-steer box.
 *
 * Visual: a rounded box top rule — `╭─ Steering ──────────────╮` — where the
 * word `Steering` is inset as the box title (exactly like every other titled
 * surface) and a short spotlight sweeps a small window that **spans the title**.
 * The spotlight is a 4-glyph ramp `· ∙ • ●` (faint → bold) that replaces the
 * cells it covers: plain rule cells become the trail, and a title letter under
 * the head (`●`) brightens to accent. The window is deliberately short and
 * centered on the title, so the spotlight passes *through* `Steering` — lighting
 * each letter as it goes — without ever travelling to the far corners. It sweeps
 * left→right, bounces right→left, one direction at a time. Constant visible
 * width every frame; monochrome (brightness varies, hue never does). The owning
 * {@link QueuedMessageBox} renders body + bottom border only, so the indicator +
 * box read as one framed block with an animated title rule.
 *
 * Package boundary: this lives in `packages/tui` and stays theme-agnostic — the
 * caller injects both the brightness stylers and the border glyphs/paint, so it
 * never imports coding-agent chrome.
 *
 * Lifecycle: self-driving via `setInterval`; the owner MUST call {@link dispose}
 * (or {@link stop}) before dropping the instance — containers `clear()` without
 * disposing children, so a leaked interval would repaint a detached node.
 */

const FRAME_MS = 100;
// Spotlight ramp from faint to bold. The head cell shows `●`, the near trail
// `• ∙ ·`, cells ahead of the head stay untouched. All four glyphs are part of
// one moving spotlight — a size ramp, never equal dots.
const GLYPHS = ["·", "∙", "•", "●"] as const;
const MAX_LEVEL = GLYPHS.length - 1;
// How far the spotlight extends to either side of its head position, in cells.
// Keeping this equal to MAX_LEVEL means the full ramp `· ∙ • ●` is always
// visible together as the spotlight travels.
const TRAIL = MAX_LEVEL;
// The spotlight window is anchored on the title and only extends a few cells
// beyond it on each side, so the sweep passes *through* `Steering` but never
// reaches the far border.
const PADDING = 3;
// Below this the titled rule has no room; fall back to the bare word so a very
// narrow terminal still shows *something* without breaking layout width.
const MIN_BORDER_WIDTH = 8;

type StyleFns = {
	/** Dim/dark styling for faint particles. */
	dim: (s: string) => string;
	/** Mid styling for the resting title word and the near trail. */
	mid: (s: string) => string;
	/** Bright/bold styling for the spotlight head (`●`) and the letter it crosses. */
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
	// Spotlight head position along the inner rule, and its travel direction. It
	// sweeps left→right, then bounces right→left — one clear sweep at a time, the
	// full `· ∙ • ●` ramp visible together as it moves through the title.
	#pos = 0;
	#dir: 1 | -1 = 1;
	#intervalId?: NodeJS.Timeout;
	#active = false;
	// Last layout width, captured in render(); the animation timer reads it to
	// bound the spotlight's travel window.
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

	/**
	 * Travel window for the spotlight head, chosen so the ramp passes *through*
	 * the title without reaching the far border. The head ranges from a few cells
	 * before the title to a few cells after it; the trail extends `TRAIL` further
	 * behind, so the full `· ∙ • ●` ramp is always visible together.
	 */
	#window(width: number): { inner: number; titleStart: number; titleEnd: number; min: number; max: number } {
		const inner = Math.max(0, width - 2);
		const titleStr = ` ${this.#word} `;
		// Center the title so the comet (head ● + trail ·∙•) sweeps *through* it,
		// left→right→left — matching the approved comet-bounce design.
		const titleStart = Math.max(1, Math.floor((inner - titleStr.length) / 2));
		const titleEnd = Math.min(inner, titleStart + titleStr.length); // exclusive
		// The head must stay at least `TRAIL` cells from the left edge so the whole
		// `· ∙ • ●` ramp (head + TRAIL cells behind it) stays on the rule every
		// frame — never clipped at the left corner. Anchor the window on the title
		// with a little padding on each side, then floor `min` by that guard.
		const min = Math.max(TRAIL, titleStart - PADDING);
		const max = Math.min(inner - 1, titleEnd + PADDING);
		return { inner, titleStart, titleEnd, min, max };
	}

	/** Activate (animate) or deactivate (stop + show a static idle rule). Idempotent. */
	setActive(active: boolean): void {
		if (active) {
			if (this.#intervalId) return;
			this.#active = true;
			this.#invalidateFrame();
			this.#intervalId = setInterval(() => {
				// Advance the spotlight head one cell in the current direction; reverse
				// at each end of the title window so it sweeps through `Steering`,
				// then back — never out to the far border.
				const { min, max } = this.#window(this.#lastWidth);
				if (max <= min) {
					this.#pos = min;
				} else {
					const next = this.#pos + this.#dir;
					if (next >= max) {
						this.#pos = max;
						this.#dir = -1;
					} else if (next <= min) {
						this.#pos = min;
						this.#dir = 1;
					} else {
						this.#pos = next;
					}
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
	 * the timer only advances the head and asks the TUI to re-render this node.
	 */
	render(width: number): readonly string[] {
		this.#lastWidth = width;
		const { min, max } = this.#window(width);
		const pos = Math.min(Math.max(min, this.#pos), max);
		const sig = `${width}|${pos}|${this.#dir}|${this.#active ? 1 : 0}`;
		if (this.#cacheLine && this.#cacheSig === sig) return this.#cacheLine;
		const line = this.#buildLine(width, pos);
		this.#cacheLine = [line];
		this.#cacheSig = sig;
		return this.#cacheLine;
	}

	/**
	 * One frame: `╭` + inner rule + `╮`. The inner cells carry the inset title
	 * `␣Steering␣` (after a single leading rule cell). A spotlight at `pos` shows
	 * `●` and trails `• ∙ ·` *behind* it along its travel direction; cells ahead
	 * of the head stay plain. A title letter directly under the head (`●`)
	 * brightens to accent; the rest of the word rests in mid. Constant width.
	 */
	#buildLine(width: number, pos: number): string {
		const { topLeft, topRight, horizontal, paint } = this.#border;
		if (width < MIN_BORDER_WIDTH) {
			return this.#active ? this.#styles.bright(this.#word) : this.#styles.mid(this.#word);
		}
		const { inner, titleStart, titleEnd, min, max } = this.#window(width);
		const titleStr = ` ${this.#word} `;
		let out = paint(topLeft);
		for (let c = 0; c < inner; c++) {
			// Spotlight ramp `· ∙ • ●` (faint → bold). On rule cells each glyph of the
			// ramp paints directly; on title cells the trail passes *under* the word
			// (letters stay intact) and only the head `●` brightens the letter it
			// crosses — a spotlight passing through `Steering`. Outside the window the
			// rule and title rest untouched, so the sweep never reaches the far border.
			const behind = this.#dir > 0 ? pos - c : c - pos;
			const onRamp = this.#active && c >= min - TRAIL && c <= max + TRAIL && behind >= 0 && behind <= MAX_LEVEL;
			const level = onRamp ? MAX_LEVEL - behind : -1;
			if (c >= titleStart && c < titleEnd) {
				const ch = titleStr[c - titleStart] ?? " ";
				// Title cell: only the head illuminates the letter; the trail renders
				// under the text (letter unchanged). Spaces in the title keep the head
				// glyph visible so the sweep still reads across the margins.
				if (level === MAX_LEVEL && ch !== " ") out += this.#styles.bright(ch);
				else if (level === MAX_LEVEL && ch === " ") out += this.#styles.bright(GLYPHS[MAX_LEVEL]);
				else out += ch === " " ? " " : this.#styles.mid(ch);
			} else if (level >= 0) {
				out += level === MAX_LEVEL ? this.#styles.bright(GLYPHS[MAX_LEVEL]) : this.#styles.mid(GLYPHS[level]);
			} else {
				out += paint(horizontal);
			}
		}
		out += paint(topRight);
		return out;
	}
}
