import type { TUI } from "../tui";
import { Text } from "./text";

/**
 * Animated "Steering" indicator for the pending-queue bar.
 *
 * Visual: the word `Steering` sits centered on a fixed-width track flanked by
 * particles. A *pulse wave* flows continuously inward from both sides toward the
 * word and through its letters: each cell swells small→large→small (`· ∙ • ●`)
 * as the wave front passes it, so the dots visibly travel rather than blink in
 * place, and each letter brightens in turn as the front sweeps under it. The
 * wave is periodic (it loops, it does not bounce), giving a steady flowing
 * pulse. Monochrome by design: only brightness (dim → normal → bold) and glyph
 * size vary, never the hue, and the rendered string keeps a constant visible
 * width every frame so the pending layout never jitters.
 *
 * Lifecycle: self-driving via `setInterval`; the owner MUST call {@link dispose}
 * (or {@link stop}) before dropping the instance — containers `clear()` without
 * disposing children, so a leaked interval would repaint a detached node.
 */

const FRAME_MS = 90;
// Glyph ramp from faint to bold. The wave front maps a cell's wave-phase to one
// of these: 0 → blank-ish, rising to ● at the crest, then falling back.
const GLYPHS = ["·", "∙", "•", "●"] as const;
// Cells per full wave (crest-to-crest). A new front enters every WAVE_LEN frames,
// so several fronts ride the track at once → a continuously flowing pulse.
const WAVE_LEN = 6;
const EMPTY = " ";

type StyleFns = {
	/** Dim/dark styling for idle track + faint particles. */
	dim: (s: string) => string;
	/** Mid styling for the word and the rising/falling shoulders of a wave crest. */
	mid: (s: string) => string;
	/** Bright/bold styling for a wave crest (●) and the letter it is sweeping under. */
	bright: (s: string) => string;
};

export class SteeringIndicator extends Text {
	#ui: TUI | null = null;
	#styles: StyleFns;
	#word: string;
	#sideWidth: number;
	#gap: number;
	#trackWidth: number;
	// Monotonic frame counter driving the flowing wave; only its value mod WAVE_LEN
	// matters, so it never needs resetting.
	#phase = 0;
	#intervalId?: NodeJS.Timeout;

	/**
	 * @param ui      TUI for component-scoped redraws.
	 * @param styles  dim/mid/bright stylers (hue stays constant; only brightness varies).
	 * @param word    the centered word (default `Steering`).
	 * @param sideWidth particle columns on each side of the word (default 6).
	 * @param gap     spaces between the side track and the word (default 1).
	 */
	constructor(ui: TUI, styles: StyleFns, word = "Steering", sideWidth = 6, gap = 1) {
		super("", 1, 0);
		this.#ui = ui;
		this.#styles = styles;
		this.#word = word;
		this.#sideWidth = Math.max(1, sideWidth);
		this.#gap = Math.max(0, gap);
		// Full track: [side] gap [word] gap [side]. Pulse fronts flow inward across it.
		this.#trackWidth = this.#sideWidth * 2 + this.#gap * 2 + this.#word.length;
		this.#renderIdle();
	}

	/** Activate (animate) or deactivate (stop + show a static idle frame). Idempotent. */
	setActive(active: boolean): void {
		if (active) {
			if (this.#intervalId) return;
			this.#render();
			this.#intervalId = setInterval(() => {
				// Advance the flowing wave one cell; fronts loop continuously inward.
				this.#phase = (this.#phase + 1) % WAVE_LEN;
				this.#render();
			}, FRAME_MS);
		} else {
			this.stop();
			this.#renderIdle();
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

	/**
	 * Build one frame. The track is `[side] gap [word] gap [side]`. A pulse wave
	 * flows inward from both edges toward the word: a cell's glyph size is a
	 * triangular function of its phase to the nearest wave crest, and crests march
	 * one cell per frame, so each dot swells `· → ∙ → • → ●` and shrinks back as
	 * the front passes — the pulse visibly travels. The word's letters brighten in
	 * turn as a crest sweeps under them. Constant visible width every frame.
	 */
	#render(): void {
		const wordStart = this.#sideWidth + this.#gap;
		const wordEnd = wordStart + this.#word.length; // exclusive
		let out = "";
		for (let col = 0; col < this.#trackWidth; col++) {
			// flow = how far this cell is along the inward direction (0 at the outer
			// edge of each side, increasing toward the word). The right side mirrors
			// the left so both pulses travel inward, meeting at the word.
			const inWord = col >= wordStart && col < wordEnd;
			const isLeftGap = col >= wordStart - this.#gap && col < wordStart;
			const isRightGap = col >= wordEnd && col < wordEnd + this.#gap;
			if (isLeftGap || isRightGap) {
				out += EMPTY;
				continue;
			}
			let flow: number;
			if (col < wordStart) {
				flow = col; // left side: 0..sideWidth-1, flowing rightward (inward)
			} else if (col >= wordEnd) {
				flow = this.#trackWidth - 1 - col; // right side: mirrored, flowing leftward
			} else {
				// Inside the word: continue the left side's flow coordinate across the
				// gap so a crest leaving the side sweeps straight through the letters.
				flow = this.#sideWidth + this.#gap + (col - wordStart);
			}
			// Triangular wave: 0 at the crest, rising with distance to it, folded so
			// the ramp is symmetric. level 3 = crest (●), 0 = trough (faint/blank).
			const tide = (((flow - this.#phase) % WAVE_LEN) + WAVE_LEN) % WAVE_LEN;
			const folded = tide > WAVE_LEN / 2 ? WAVE_LEN - tide : tide; // 0..WAVE_LEN/2
			const level = Math.max(0, GLYPHS.length - 1 - folded); // 0..3, peak at crest
			if (inWord) {
				const ch = this.#word[col - wordStart];
				// Crest under the letter → bright; shoulder → mid; trough → dim.
				out += level >= 3 ? this.#styles.bright(ch) : level >= 1 ? this.#styles.mid(ch) : this.#styles.dim(ch);
			} else if (level <= 0) {
				out += this.#styles.dim(EMPTY); // trough: blank cell, keeps width
			} else {
				const glyph = GLYPHS[level];
				out += level >= 3 ? this.#styles.bright(glyph) : this.#styles.mid(glyph);
			}
		}
		if (this.setText(out) && this.#ui) {
			// Component-scoped: a frame changes only this node, so the TUI reuses
			// every other subtree instead of re-walking the whole transcript.
			this.#ui.requestComponentRender(this);
		}
	}

	/**
	 * Static idle frame: the word in mid styling on an otherwise blank track, same
	 * visible width as an animated frame so toggling active never shifts layout.
	 */
	#renderIdle(): void {
		const left = EMPTY.repeat(this.#sideWidth + this.#gap);
		const right = EMPTY.repeat(this.#sideWidth + this.#gap);
		const out = `${left}${this.#styles.mid(this.#word)}${right}`;
		if (this.setText(out) && this.#ui) {
			this.#ui.requestComponentRender(this);
		}
	}
}
