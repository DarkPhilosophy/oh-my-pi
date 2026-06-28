import type { TUI } from "../tui";
import { Text } from "./text";

/**
 * Animated "Steering" indicator rendered AS the top border of the pending
 * streaming-steer box.
 *
 * Visual: a dashed box top rule — `╭╌╌[   Steering   ]╌╌╌╮` — with the word
 * `Steering` inset as the box title. A 4-glyph ramp `· ∙ • ●` (faint → bold)
 * bounces *strictly inside* the bracketed title: the head `●` brightens the
 * letter it crosses, the trail `· ∙ •` renders in the pad spaces, and the
 * surrounding rule stays static — the comet never spills outside `[ … ]`. It
 * sweeps left→right, bounces right→left. Constant visible width every frame;
 * monochrome (brightness varies, hue never does). The owning
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
		const titleStr = `[   ${this.#word}   ]`;
		// Left-align the title with a small offset (not flush to the corner); clamp
		// so a narrow rule never makes the bounce window invalid.
		const titleStart = Math.max(0, Math.min(2, inner - titleStr.length));
		const titleEnd = Math.min(inner, titleStart + titleStr.length); // exclusive
		// The comet bounces strictly *within* the bracketed title (`[   Steering   ]`)
		// so the head + trail never spill onto the surrounding rule — the head
		// ranges across the title cells only, edge to edge.
		const min = titleStart;
		const max = Math.min(inner - 1, titleEnd - 1);
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
		const { inner, titleStart, titleEnd } = this.#window(width);
		const titleStr = `[   ${this.#word}   ]`;
		let out = paint(topLeft);
		for (let c = 0; c < inner; c++) {
			// Comet `· ∙ • ●` (faint → bold) confined to the bracketed title: the head
			// bounces across the title cells and the trail renders in the pad spaces, so
			// the sweep reads *through* `[   Steering   ]` without spilling onto the
			// surrounding rule. Letters stay intact (trail passes under the word); only
			// the head `●` brightens the letter it crosses.
			const behind = this.#dir > 0 ? pos - c : c - pos;
			const onRamp = this.#active && c >= titleStart && c < titleEnd && behind >= 0 && behind <= MAX_LEVEL;
			const level = onRamp ? MAX_LEVEL - behind : -1;
			if (c >= titleStart && c < titleEnd) {
				const ch = titleStr[c - titleStart] ?? " ";
				if (ch === " ") {
					// Pad space: the comet's `· ∙ • ●` ramp renders here as it travels.
					if (level === MAX_LEVEL) out += this.#styles.bright(GLYPHS[MAX_LEVEL]);
					else if (level >= 0) out += this.#styles.mid(GLYPHS[level]);
					else out += " ";
				} else {
					// Letter: a glow that follows the head — bright core, mid halo, dim
					// rest — so the comet reads as light spilling across the word, not a
					// single brightened letter.
					const d = Math.abs(c - pos);
					if (d <= 1) out += this.#styles.bright(ch);
					else if (d <= 2) out += this.#styles.mid(ch);
					else out += this.#styles.dim(ch);
				}
			} else {
				out += paint(horizontal);
			}
		}
		out += paint(topRight);
		return out;
	}
}
