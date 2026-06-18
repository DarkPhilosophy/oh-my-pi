import type { TUI } from "../tui";
import { Text } from "./text";

/**
 * Animated "Steering" indicator for the pending-queue bar.
 *
 * Visual: the word `Steering` sits centered on a fixed-width track flanked by
 * particles. A "comet" sweeps left→right→left in a loop; the cell it occupies
 * shows the large glyph, the trailing cells fade through smaller glyphs, and as
 * the comet passes under the word each letter briefly brightens — giving the
 * illusion of motion flowing *through* the text. Monochrome by design: only the
 * brightness (dim → normal → bold) and the glyph size vary, never the hue, and
 * the rendered string keeps a constant visible width every frame so the pending
 * layout never jitters.
 *
 * Lifecycle: self-driving via `setInterval`; the owner MUST call {@link dispose}
 * (or {@link stop}) before dropping the instance — containers `clear()` without
 * disposing children, so a leaked interval would repaint a detached node.
 */

const FRAME_MS = 90;
// Glyph sizes from faint to bold, used for the comet head + its fading trail.
const TRAIL = ["·", "∙", "•", "●"] as const;
const EMPTY = " ";

type StyleFns = {
	/** Dim/dark styling for idle track + faint particles. */
	dim: (s: string) => string;
	/** Mid styling for the word and near-comet particles. */
	mid: (s: string) => string;
	/** Bright/bold styling for the comet head + the letter it is passing under. */
	bright: (s: string) => string;
};

export class SteeringIndicator extends Text {
	#ui: TUI | null = null;
	#styles: StyleFns;
	#word: string;
	#sideWidth: number;
	#gap: number;
	#trackWidth: number;
	#pos = 0;
	#dir = 1;
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
		// Full track: [side] gap [word] gap [side]. The comet travels the whole span.
		this.#trackWidth = this.#sideWidth * 2 + this.#gap * 2 + this.#word.length;
		this.#renderIdle();
	}

	/** Activate (animate) or deactivate (stop + show a static idle frame). Idempotent. */
	setActive(active: boolean): void {
		if (active) {
			if (this.#intervalId) return;
			this.#render();
			this.#intervalId = setInterval(() => {
				// Bounce the comet across the full track.
				this.#pos += this.#dir;
				if (this.#pos >= this.#trackWidth - 1) {
					this.#pos = this.#trackWidth - 1;
					this.#dir = -1;
				} else if (this.#pos <= 0) {
					this.#pos = 0;
					this.#dir = 1;
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
	 * Build one frame. The track is `[side] gap [word] gap [side]`. Each side cell
	 * renders a particle whose size/brightness depends on its distance from the
	 * comet head; the word region renders each letter, brightening the one the
	 * comet is currently under. Constant visible width every frame.
	 */
	#render(): void {
		const wordStart = this.#sideWidth + this.#gap;
		const wordEnd = wordStart + this.#word.length; // exclusive
		let out = "";
		for (let col = 0; col < this.#trackWidth; col++) {
			const inWord = col >= wordStart && col < wordEnd;
			const dist = Math.abs(col - this.#pos);
			if (inWord) {
				const ch = this.#word[col - wordStart];
				// Comet under this letter → bright; just beside it → mid; else dim.
				out += dist === 0 ? this.#styles.bright(ch) : dist === 1 ? this.#styles.mid(ch) : this.#styles.dim(ch);
			} else if (col >= wordStart - this.#gap && col < wordStart) {
				out += EMPTY; // left gap
			} else if (col >= wordEnd && col < wordEnd + this.#gap) {
				out += EMPTY; // right gap
			} else {
				// Side particle: size/brightness by proximity to the comet head.
				if (dist === 0) {
					out += this.#styles.bright(TRAIL[3]);
				} else if (dist <= 3) {
					out += this.#styles.mid(TRAIL[3 - dist]);
				} else {
					out += this.#styles.dim(EMPTY);
				}
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
