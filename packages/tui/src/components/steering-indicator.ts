import type { TUI } from "../tui";
import { Text } from "./text";

/**
 * Animated "Steering" indicator rendered AS the top border of the pending
 * streaming-steer box.
 *
 * Visual: a rounded box top rule — `╭─ Steering ─ ●─●─●─● ─────────╮` — where
 * the word `Steering` is inset as the box title (exactly like every other titled
 * surface) and a short cluster of four equal dots sits just after it. The four
 * dots are always visible together and slide gently a few cells right→left→right
 * near the title; they never sweep the whole rule, never fade, and never change
 * size (no trailing comet, no grow). Plain rule cells stay `─`. Monochrome by
 * design: the dots rest in one accent brightness and the title letters stay
 * muted, and the line keeps a constant visible width every frame so the pending
 * layout never jitters. The owning {@link QueuedMessageBox} renders its body +
 * bottom border only, so the indicator + box read as one framed block with an
 * animated title rule.
 *
 * Package boundary: this lives in `packages/tui` and stays theme-agnostic — the
 * caller injects both the brightness stylers and the border glyphs/paint, so it
 * never imports coding-agent chrome.
 *
 * Lifecycle: self-driving via `setInterval`; the owner MUST call {@link dispose}
 * (or {@link stop}) before dropping the instance — containers `clear()` without
 * disposing children, so a leaked interval would repaint a detached node.
 */

const FRAME_MS = 110;
// The dot cluster: four equal dots, all the same glyph — they read as four
// distinct beads (separated by a rule cell), never a fading/growing comet.
const DOT = "●";
const DOT_COUNT = 4;
// Rule cells between adjacent dots when there is room (`●─●─●─●`); drops to 0
// (`●●●●`) on tight rules so all four dots still fit near the title.
const DOT_GAP = 1;
// One plain rule cell between the title word and the cluster.
const GAP_AFTER_TITLE = 1;
// How far the whole cluster slides from its resting position — kept short so the
// dots stay "just past the text" rather than travelling the whole border.
const TRAVEL_MAX = 6;
// Below this the titled rule has no room; fall back to the bare word so a very
// narrow terminal still shows *something* without breaking layout width.
const MIN_BORDER_WIDTH = 8;

type StyleFns = {
	/** Dim/dark styling for faint particles. */
	dim: (s: string) => string;
	/** Mid styling for the resting title word. */
	mid: (s: string) => string;
	/** Bright/bold styling for the dot cluster. */
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

/** Geometry of one frame, derived from the layout width. */
type Layout = {
	inner: number;
	titleStr: string;
	titleStart: number;
	titleEnd: number;
	clusterStart: number;
	clusterWidth: number;
	step: number;
	fits: boolean;
	travel: number;
};

export class SteeringIndicator extends Text {
	#ui: TUI | null = null;
	#styles: StyleFns;
	#border: BorderStyle;
	#word: string;
	// Cluster slide offset within its short travel window, and the travel
	// direction. The four dots move together right→left→right by a few cells; they
	// never leave the window next to the title.
	#offset = 0;
	#dir: 1 | -1 = 1;
	#intervalId?: NodeJS.Timeout;
	#active = false;
	// Last layout width, captured in render(); the animation timer reads it to
	// bounce the cluster at the real window ends.
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

	/** Frame geometry for a given layout width: title inset + dot-cluster window. */
	#layout(width: number): Layout {
		const inner = Math.max(0, width - 2);
		const titleStr = ` ${this.#word} `;
		const titleStart = 1;
		const titleEnd = Math.min(inner, titleStart + titleStr.length); // exclusive
		const clusterStart = titleEnd + GAP_AFTER_TITLE;
		const room = inner - clusterStart; // cells available right of the title gap
		// Prefer spaced dots (`●─●─●─●`); collapse the gap if the rule is tight.
		const spacedWidth = DOT_COUNT + (DOT_COUNT - 1) * DOT_GAP;
		const gap = room >= spacedWidth ? DOT_GAP : 0;
		const clusterWidth = DOT_COUNT + (DOT_COUNT - 1) * gap;
		const fits = room >= DOT_COUNT; // at least four adjacent dots
		// Keep at least one plain rule cell before the right corner.
		const travel = fits ? Math.max(0, Math.min(TRAVEL_MAX, room - clusterWidth)) : 0;
		return { inner, titleStr, titleStart, titleEnd, clusterStart, clusterWidth, step: gap + 1, fits, travel };
	}

	/** Activate (animate) or deactivate (stop + show a static idle rule). Idempotent. */
	setActive(active: boolean): void {
		if (active) {
			if (this.#intervalId) return;
			this.#active = true;
			this.#invalidateFrame();
			this.#intervalId = setInterval(() => {
				// Slide the cluster one cell, bouncing at the short window's ends so the
				// four dots drift right→left→right just past the title.
				const travel = this.#layout(this.#lastWidth).travel;
				if (travel <= 0) {
					this.#offset = 0;
				} else {
					const next = this.#offset + this.#dir;
					if (next >= travel) {
						this.#offset = travel;
						this.#dir = -1;
					} else if (next <= 0) {
						this.#offset = 0;
						this.#dir = 1;
					} else {
						this.#offset = next;
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
	 * the timer only advances the cluster and asks the TUI to re-render this node.
	 */
	render(width: number): readonly string[] {
		this.#lastWidth = width;
		const travel = this.#layout(width).travel;
		const offset = Math.min(Math.max(0, this.#offset), travel);
		const sig = `${width}|${offset}|${this.#active ? 1 : 0}`;
		if (this.#cacheLine && this.#cacheSig === sig) return this.#cacheLine;
		const line = this.#buildLine(width, offset);
		this.#cacheLine = [line];
		this.#cacheSig = sig;
		return this.#cacheLine;
	}

	/**
	 * One frame: `╭` + inner rule + `╮`. The inner cells carry the inset title
	 * `␣Steering␣` (after a single leading rule cell, matching the shared
	 * top-border layout). A short cluster of four equal dots sits just past the
	 * title and slides by `offset` within its window; every other cell stays a
	 * plain `─` rule. Constant visible width, no fade, no size ramp.
	 */
	#buildLine(width: number, offset: number): string {
		const { topLeft, topRight, horizontal, paint } = this.#border;
		if (width < MIN_BORDER_WIDTH) {
			return this.#active ? this.#styles.bright(this.#word) : this.#styles.mid(this.#word);
		}
		const layout = this.#layout(width);
		const { inner, titleStr, titleStart, titleEnd, clusterStart, clusterWidth, step, fits } = layout;
		const clusterLeft = clusterStart + offset;
		const clusterEnd = clusterLeft + clusterWidth; // exclusive
		const showDots = this.#active && fits;
		let out = paint(topLeft);
		for (let c = 0; c < inner; c++) {
			if (c >= titleStart && c < titleEnd) {
				const ch = titleStr[c - titleStart] ?? " ";
				// Title rests muted; margins stay clean.
				out += ch === " " ? " " : this.#styles.mid(ch);
			} else if (showDots && c >= clusterLeft && c < clusterEnd && (c - clusterLeft) % step === 0) {
				// One of the four equal dots — all the same brightness, every frame.
				out += this.#styles.bright(DOT);
			} else {
				out += paint(horizontal);
			}
		}
		out += paint(topRight);
		return out;
	}
}
