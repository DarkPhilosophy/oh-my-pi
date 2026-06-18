import type { TUI } from "../tui";
import { Text } from "./text";

/**
 * Animated "Steering" indicator for the pending-queue bar.
 *
 * Visual: the word `Steering` sits centered on a fixed-width track flanked by
 * particles. A single comet sweeps the whole row in one direction — left→right,
 * then bouncing back right→left — with a fading trail (`● • ∙ ·`) behind it and
 * nothing ahead, so the motion reads as one clear directional sweep rather than
 * scattered blinking. Each letter brightens as the comet passes under it.
 * Monochrome by design: only brightness (dim → normal → bold) and glyph size
 * vary, never the hue, and the rendered string keeps a constant visible width
 * every frame so the pending layout never jitters.
 *
 * Lifecycle: self-driving via `setInterval`; the owner MUST call {@link dispose}
 * (or {@link stop}) before dropping the instance — containers `clear()` without
 * disposing children, so a leaked interval would repaint a detached node.
 */

const FRAME_MS = 90;
// Glyph ramp from faint to bold: the comet head shows ●, and the trail behind it
// fades • ∙ · as the distance from the head grows.
const GLYPHS = ["·", "∙", "•", "●"] as const;
const EMPTY = " ";

type StyleFns = {
	/** Dim/dark styling for idle track + faint particles. */
	dim: (s: string) => string;
	/** Mid styling for the word and the comet's near trail. */
	mid: (s: string) => string;
	/** Bright/bold styling for the comet head (●) and the letter it is sweeping under. */
	bright: (s: string) => string;
};

export class SteeringIndicator extends Text {
	#ui: TUI | null = null;
	#styles: StyleFns;
	#word: string;
	#sideWidth: number;
	#gap: number;
	#trackWidth: number;
	// The comet position on the track and its travel direction. The comet sweeps
	// the whole row left→right, then bounces back right→left — one clear direction
	// at a time (never two simultaneous waves), with a trail fading behind it.
	#pos = 0;
	#dir: 1 | -1 = 1;
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
		// Full track: [side] gap [word] gap [side]. The comet sweeps the whole span.
		this.#trackWidth = this.#sideWidth * 2 + this.#gap * 2 + this.#word.length;
		this.#renderIdle();
	}

	/** Activate (animate) or deactivate (stop + show a static idle frame). Idempotent. */
	setActive(active: boolean): void {
		if (active) {
			if (this.#intervalId) return;
			this.#render();
			this.#intervalId = setInterval(() => {
				// Sweep the comet one cell in the current direction; reverse at each end so
				// it travels left→right then right→left (a single clear sweep each way).
				const next = this.#pos + this.#dir;
				if (next >= this.#trackWidth - 1) {
					this.#pos = this.#trackWidth - 1;
					this.#dir = -1;
				} else if (next <= 0) {
					this.#pos = 0;
					this.#dir = 1;
				} else {
					this.#pos = next;
				}
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
	 * Build one frame. The track is `[side] gap [word] gap [side]`. A single comet
	 * sits at `#pos`; the cell it occupies shows the largest glyph (`●` / a bright
	 * letter), and the cells *behind* it (opposite its travel direction) fade
	 * through `• ∙ ·` as a trail. Nothing renders ahead of the comet, so the motion
	 * reads as one clear sweep — left→right, then right→left after the bounce. The
	 * word's letters brighten as the comet passes under them. Constant visible width.
	 */
	#render(): void {
		const wordStart = this.#sideWidth + this.#gap;
		const wordEnd = wordStart + this.#word.length; // exclusive
		const maxLevel = GLYPHS.length - 1; // index of the brightest glyph (●)
		let out = "";
		for (let col = 0; col < this.#trackWidth; col++) {
			// Trail distance: how far this cell is *behind* the comet along its travel
			// direction. 0 at the comet head; positive behind it; negative ahead (no
			// glyph). #dir > 0 (moving right) → trail is to the left, and vice-versa.
			const behind = this.#dir > 0 ? this.#pos - col : col - this.#pos;
			const level = behind >= 0 && behind <= maxLevel ? maxLevel - behind : -1;
			const inWord = col >= wordStart && col < wordEnd;
			const isGap =
				(col >= wordStart - this.#gap && col < wordStart) || (col >= wordEnd && col < wordEnd + this.#gap);
			if (inWord) {
				const ch = this.#word[col - wordStart];
				// Comet on the letter → bright; just behind → mid; otherwise dim.
				out +=
					level >= maxLevel ? this.#styles.bright(ch) : level >= 1 ? this.#styles.mid(ch) : this.#styles.dim(ch);
			} else if (level < 0) {
				// Ahead of the comet (or fully past it): blank cell, keeps the width.
				out += this.#styles.dim(EMPTY);
			} else if (isGap && level < maxLevel) {
				// Gap cell with only trail (not the head) stays blank so the word keeps a
				// clean margin; the head itself still shows so the comet never vanishes.
				out += this.#styles.dim(EMPTY);
			} else {
				const glyph = GLYPHS[level];
				out += level >= maxLevel ? this.#styles.bright(glyph) : this.#styles.mid(glyph);
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
