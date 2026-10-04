import { type DaemonConnectionSnapshot, formatDaemonWelcomeStatus } from "../chrome/daemon-status";
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { formatDoubleTap, formatKeyHint, formatKeyHints, type KeyName } from "../app-keybindings";
import { editorKey } from "../chrome/keybinding-hints";
import { getKeybindings, type Keybinding } from "../keybindings";
import { card, col, keyed, node, row, span, text } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode } from "../native/node";
import { plainLine } from "../native/spans";
import { isNativeRendering } from "../native/state";
import { TERMINAL } from "../terminal-capabilities";
import { theme } from "../theme/theme";
import type { Component } from "../tui";
import { padding, replaceTabs, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import tipsText from "./tips.txt" with { type: "text" };

/** Tips embedded at build time, one per line; blanks dropped. Key placeholders
 *  (see {@link expandTipKeys}) stay raw until render time. */
const TIPS: readonly string[] = tipsText
	.split("\n")
	.map(line => line.trim())
	.filter(line => line.length > 0);

/** Trailing marker that flags a tip as a "what's new" callout. Stripped before
 *  wrapping (with any preceding whitespace) and replaced by {@link NEW_TAG_TEXT}
 *  painted as a shimmering rainbow. Non-global so `.test` stays stateless. */
const NEW_TIP_MARKER = /\s*\[NEW\]\s*$/;

/** Visible text rendered in place of {@link NEW_TIP_MARKER}. */
const NEW_TAG_TEXT = "NEW!";

/** Milliseconds for one full hue rotation of the rainbow "NEW!" tag. */
const NEW_GLOW_PERIOD_MS = 1500;

/** Selection weight for "[NEW]" tips; ordinary tips weigh 1, so a freshly added
 *  affordance surfaces this many times as often. */
const NEW_TIP_WEIGHT = 4;

/** Pick a tip from `tips`, biased toward "[NEW]" tips by {@link NEW_TIP_WEIGHT};
 *  `r` is a uniform sample in [0, 1). Returns "" when `tips` is empty.
 *  Exported for tests. */
export function pickWeightedTip(tips: readonly string[], r: number): string {
	if (tips.length === 0) return "";
	const weights = tips.map(tip => (NEW_TIP_MARKER.test(tip) ? NEW_TIP_WEIGHT : 1));
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	let acc = r * total;
	for (let i = 0; i < tips.length; i++) {
		acc -= weights[i] ?? 1;
		if (acc < 0) return tips[i] ?? "";
	}
	return tips[tips.length - 1] ?? "";
}

type ColorEncoding = "ansi-16m" | "ansi-256";

/** Paint each glyph of {@link NEW_TAG_TEXT} on a moving HSL rainbow. `phase`
 *  rotates the hue offset cyclically; successive renders with increasing phase
 *  shimmer, while a fixed phase yields a still rainbow. */
function renderNewTag(phase: number, encoding: ColorEncoding): string {
	const bold = "\x1b[1m";
	const reset = "\x1b[0m";
	const wrapped = ((phase % 1) + 1) % 1;
	const chars = [...NEW_TAG_TEXT];
	let out = bold;
	let prev = "";
	for (let i = 0; i < chars.length; i++) {
		const hue = Math.round(((i / chars.length + wrapped) % 1) * 360);
		const color = Bun.color(`hsl(${hue}, 95%, 60%)`, encoding) ?? "";
		if (color !== prev) {
			out += color;
			prev = color;
		}
		out += chars[i];
	}
	return out + reset;
}

/** Key placeholders in tips.txt: `{key:shift+tab}`, `{keys:up,down}`, `{tap:left}`, `{action:tui.editor.undo}`. */
const TIP_KEY_PLACEHOLDER = /\{(key|keys|tap|action):([^}]+)\}/g;

const MODIFIER_NAMES: Record<string, true | undefined> = {
	ctrl: true,
	shift: true,
	alt: true,
	super: true,
};

/** A `+`-joined chord whose leading parts are modifiers (`ctrl+o`, `shift`, `left`). */
function isKeyName(key: string): key is KeyName {
	const parts = key.split("+");
	return parts.every((part, i) => part.length > 0 && (i === parts.length - 1 || MODIFIER_NAMES[part] === true));
}

function isKeybinding(action: string): action is Keybinding {
	return action in getKeybindings().getResolvedBindings();
}

/** Expand tip key placeholders through the key formatter; malformed ones stay verbatim. */
function expandTipKeys(tip: string): string {
	return tip.replace(TIP_KEY_PLACEHOLDER, (placeholder, kind: string, value: string) => {
		if (kind === "action") return isKeybinding(value) ? editorKey(value) : placeholder;
		const keys = value.split(",");
		if (!keys.every(isKeyName)) return placeholder;
		if (kind === "keys") return formatKeyHints(keys);
		const [key] = keys;
		if (key === undefined) return placeholder;
		return kind === "tap" ? formatDoubleTap(key) : formatKeyHint(key);
	});
}

/**
 * The welcome tip as lines of at most `width` columns: `Tip:` and the body
 * wrapped together, with no indent, so the banner can center each line.
 * `[]` when `width` leaves no room for a useful line.
 */
export function renderWelcomeTip(tip: string, width: number, phase = 0): string[] {
	const label = "Tip: ";
	if (width - visibleWidth(label) < 8) return [];

	const isNew = NEW_TIP_MARKER.test(tip);
	const body = expandTipKeys(isNew ? tip.replace(NEW_TIP_MARKER, "") : tip);

	// Trailing spaces left by the wrap would count toward the width the banner centers.
	const wrapped = wrapTextWithAnsi(replaceTabs(`${label}${body}`), width).map(line => line.trimEnd());
	if (wrapped.length === 0) return [];

	// Pull both colors from the active theme so the line stays readable on light
	// themes; the previous hardcoded `#b48cff` / `#9ccfff` pastels (plus a manual
	// `\x1b[2m` dim on the body) dropped to ~1.5:1 contrast on a white background.
	const styledLabel = theme.fg("customMessageLabel", label);
	const lines = wrapped.map((line, index) =>
		theme.italic(
			index === 0 && line.startsWith(label)
				? `${styledLabel}${theme.fg("muted", line.slice(label.length))}`
				: theme.fg("muted", line),
		),
	);

	if (isNew) {
		// Append the rainbow tag to the final line when it fits; otherwise give it
		// a line of its own so the styled glyphs never overflow the width.
		const encoding: ColorEncoding = TERMINAL.trueColor ? "ansi-16m" : "ansi-256";
		const tag = renderNewTag(phase, encoding);
		const tagWidth = 1 + visibleWidth(NEW_TAG_TEXT); // 1 = space separator
		const lastLine = lines[lines.length - 1];
		if (lastLine !== undefined && visibleWidth(lastLine) + tagWidth <= width) {
			lines[lines.length - 1] = `${lastLine} ${tag}`;
		} else {
			lines.push(tag);
		}
	}

	return lines;
}

/**
 * The session's welcome banner. In a terminal: the gradient logo beside the
 * `omp` wordmark with the version under it (the logo alone when the lockup does
 * not fit) and the tip of the session (dropped below {@link TIP_MIN_COLUMNS}
 * columns). Natively: a card with the same logo, wordmark, version and tip
 * ({@link WelcomeComponent.describe}).
 */
export interface RecentSession {
	name: string;
	timeAgo: string;
	/** Session file; a native click on the row resumes it. */
	path?: string;
}

export interface LspServerInfo {
	name: string;
	status: "ready" | "error" | "connecting" | "available";
	fileTypes: string[];
}

export class WelcomeComponent implements Component {
	readonly #enrichedLayout: boolean;
	#animStart: number | null = null;
	#animTimer: Timer | null = null;
	#requestRender: (() => void) | null = null;
	#serverStatus: DaemonConnectionSnapshot = { state: "direct" };
	// Tip randomness is latched once so the tip is stable across renders, but
	// the nerdfont-nag gate re-reads the live preset: the startup prepaint can
	// run under the default "unicode" preset before settings resolve the real
	// one, and a memoized nag would survive the switch to "nerd".
	#nagRoll: number | undefined;
	#tipRoll: number | undefined;
	// Render cache: the welcome box is the first transcript-area component, so
	// returning a stable array reference keeps the whole frame prefix stable.
	// Bypassed while the intro animation runs (every frame differs).
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;
	#native: { tip: string | undefined; node: NativeNode } | undefined;

	constructor(
		private version: string,
		private modelName: string = "",
		private providerName: string = "",
		private recentSessions: RecentSession[] = [],
		/** Detected project servers; `null` means LSP is disabled and hides the section. */
		private lspServers: LspServerInfo[] | null = [],
	) {
		this.#enrichedLayout = arguments.length > 1;
	}

	get tip(): string | undefined {
		this.#nagRoll ??= Math.random();
		this.#tipRoll ??= Math.random();
		if (theme.getSymbolPreset() === "unicode" && this.#nagRoll < 0.1) {
			return "Please use nerdfont 😭.";
		}
		return pickWeightedTip(TIPS, this.#tipRoll) || undefined;
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
		this.#native = undefined;
	}

	/**
	 * A `card` (`omp.welcome`) mirroring the terminal banner: the lockup
	 * (`omp.welcome.lockup`: the terminal's builtin `omp` mark, which it animates,
	 * beside the wordmark with the version under it) and the tip of the session.
	 * Roles carry the look (gradient logo, type scale); a "[NEW]" tip
	 * carries a terminal-clocked shimmering tag.
	 */
	describe(_cx: DescribeContext): NativeNode {
		const tip = this.tip;
		if (this.#native && this.#native.tip === tip) return this.#native.node;
		// Brand lines are short and fixed; never wrap or truncate them.
		const art = (spans: readonly TspSpan[], role: string): NativeNode =>
			keyed(text(spans, { wrap: "none", role }), role);
		const lockupRow = keyed(
			row(
				[
					node(
						"image",
						{
							builtin: "omp",
							alt: APP_NAME,
							w: 128,
							role: "omp.welcome.logo",
						},
						undefined,
						"logo",
					),
					keyed(
						col(
							[
								art([span(APP_NAME, "strong")], "omp.welcome.wordmark"),
								art([span(`v${this.version}`, "dim mono")], "omp.welcome.version"),
							],
							{ role: "omp.welcome.mark" },
						),
						"mark",
					),
				],
				{ align: "center", gap: "md", role: "omp.welcome.lockup" },
			),
			"lockup",
		);
		const body: NativeChild[] = [lockupRow];
		if (tip) {
			const isNew = NEW_TIP_MARKER.test(tip);
			const tipText = plainLine(expandTipKeys(isNew ? tip.replace(NEW_TIP_MARKER, "") : tip));
			const tipRow: NativeChild[] = [
				node("icon", { name: "lightbulb", role: "omp.welcome.tip-icon" }),
				text(tipText, { wrap: "word", role: "omp.welcome.tip-text" }),
			];
			if (isNew) tipRow.push(node("shimmer", { text: "New", role: "omp.welcome.new" }));
			body.push(node("row", { gap: "sm", align: "start", role: "omp.welcome.tip" }, tipRow, "tip"));
		}
		// No head row or chevron: the card is the hero; the version sits under the wordmark.
		const described = card({ role: "omp.welcome" }, body);
		this.#native = { tip, node: described };
		return described;
	}

	/** The intro keeps the welcome block mutable; settling lets it retire to history. */
	isTranscriptBlockFinalized(): boolean {
		return this.#animTimer == null;
	}

	/**
	 * Play a one-shot intro that sweeps the gradient through every phase
	 * before settling on the resting frame. Safe to call multiple times —
	 * subsequent calls reset and replay.
	 */
	playIntro(requestRender: () => void): void {
		this.#stopAnimation();
		// The intro is a repaint-only gradient sweep; a TSP terminal shows the
		// settled card right away.
		if (isNativeRendering()) {
			requestRender();
			return;
		}
		this.#requestRender = requestRender;
		this.#animStart = performance.now();
		this.#requestRender();
		this.#animTimer = setInterval(() => {
			const elapsed = performance.now() - (this.#animStart ?? 0);
			const requestRender = this.#requestRender;
			if (elapsed >= INTRO_MS) {
				this.#stopAnimation();
			}
			// Stopping clears the callback, but the settled frame must still paint
			// so an oversized startup header can retire into native scrollback.
			requestRender?.();
		}, INTRO_TICK_MS);
	}

	#stopAnimation(): void {
		if (this.#animTimer != null) {
			clearInterval(this.#animTimer);
			this.#animTimer = null;
		}
		this.#animStart = null;
		this.#requestRender = null;
		// The settled (resting) frame differs from the last intro frame.
		this.invalidate();
	}

	/**
	 * Redirect a running intro's render callback to a new target when a host
	 * remounts this component mid-animation.
	 * Returns true while the intro is still animating; false = no-op (settled).
	 */
	retargetIntro(requestRender: () => void): boolean {
		if (this.#animTimer == null) return false;
		this.#requestRender = requestRender;
		return true;
	}

	/** Stop the intro immediately and settle on the resting frame. Safe when idle. */
	stopIntro(): void {
		this.#stopAnimation();
	}

	/** Update the version embedded in the welcome border title. */
	setVersion(version: string): void {
		this.version = version;
		this.invalidate();
	}

	setModel(modelName: string, providerName: string): void {
		this.modelName = modelName;
		this.providerName = providerName;
		this.invalidate();
	}

	setRecentSessions(sessions: RecentSession[]): void {
		this.recentSessions = sessions;
		this.invalidate();
	}

	setLspServers(servers: LspServerInfo[] | null): void {
		this.lspServers = servers;
		this.invalidate();
	}

	setServerStatus(snapshot: DaemonConnectionSnapshot): void {
		this.#serverStatus = snapshot;
		this.invalidate();
	}
	render(termWidth: number): readonly string[] {
		const animating = this.#animStart != null;
		if (!animating && this.#cachedLines && this.#cachedWidth === termWidth) {
			return this.#cachedLines;
		}
		const lines = this.#renderLines(termWidth);
		if (animating) {
			this.#cachedLines = undefined;
			this.#cachedWidth = -1;
		} else {
			this.#cachedLines = lines;
			this.#cachedWidth = termWidth;
		}
		return lines;
	}

	#renderLines(termWidth: number): string[] {
		if (!this.#enrichedLayout) {
			// Content keeps a column clear on each side; everything centers in the full width.
			const room = termWidth - 2;
			if (room < 4) return [];
			const logo = this.#currentLogoFrame();
			const version = theme.fg("dim", `v${this.version}`);
			const lockupWidth = LOGO_WIDTH + LOCKUP_GAP + Math.max(WORDMARK_WIDTH, visibleWidth(version));
			const art = room >= lockupWidth ? lockup(logo, version) : room >= LOGO_WIDTH ? logo : [];
			const lines = centerBlock(art, termWidth);
			const tip = termWidth >= TIP_MIN_COLUMNS ? this.#renderTip(room) : [];
			if (tip.length > 0) lines.push("", ...tip.flatMap(line => centerBlock([line], termWidth)));
			return lines;
		}

		// Box dimensions - responsive with max width and small-terminal support
		const maxWidth = 100;
		const boxWidth = Math.min(maxWidth, Math.max(0, termWidth - 2));
		if (boxWidth < 4) {
			return [];
		}
		const dualContentWidth = boxWidth - 3; // 3 = │ + │ + │
		const preferredLeftCol = 26;
		const minLeftCol = 12; // logo width
		const minRightCol = 20;
		// Dynamic model/provider labels are truncated inside the fixed column.
		// Letting them influence the responsive breakpoint changes the box height
		// when authoritative session data replaces the empty prepaint labels.
		const leftMinContentWidth = Math.max(minLeftCol, visibleWidth("Welcome back!"));
		const desiredLeftCol = Math.max(
			Math.min(preferredLeftCol, Math.max(minLeftCol, Math.floor(dualContentWidth * 0.35))),
			leftMinContentWidth,
		);
		const dualLeftCol =
			dualContentWidth >= minRightCol + 1
				? Math.min(desiredLeftCol, dualContentWidth - minRightCol)
				: Math.max(1, dualContentWidth - 1);
		const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
		const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= minRightCol;
		const leftCol = showRightColumn ? dualLeftCol : boxWidth - 2;
		const rightCol = showRightColumn ? dualRightCol : 0;

		// Logo: pick a frame from the intro animation if active, else the resting frame.
		const logoColored = this.#currentLogoFrame();

		// Left column - centered content
		const leftLines = [
			"",
			this.#centerText(theme.bold("Welcome back!"), leftCol),
			"",
			...logoColored.map(l => this.#centerText(l, leftCol)),
			"",
			this.#centerText(theme.fg("muted", this.modelName), leftCol),
			this.#centerText(theme.fg("borderMuted", this.providerName), leftCol),
			...formatDaemonWelcomeStatus(this.#serverStatus, leftCol).map(line => this.#centerText(line, leftCol)),
		];

		// Right column separator
		const separatorWidth = Math.max(0, rightCol - 2); // padding on each side
		const separator = ` ${theme.fg("dim", theme.boxRound.horizontal.repeat(separatorWidth))}`;

		// Recent sessions content
		const sessionLines: string[] = [];
		if (this.recentSessions.length === 0) {
			sessionLines.push(` ${theme.fg("dim", "No recent sessions")}`);
		} else {
			// Reserve width for the bullet prefix (" • ") and the trailing " (timeAgo)"
			// so the relative time is never the part that gets truncated. The name
			// absorbs whatever space is left.
			const bulletPrefix = ` ${theme.md.bullet} `;
			const prefixWidth = visibleWidth(bulletPrefix);
			for (const session of this.recentSessions.slice(0, WELCOME_SESSION_SLOTS)) {
				const timeSuffixRaw = ` (${session.timeAgo})`;
				const timeWidth = visibleWidth(timeSuffixRaw);
				const nameBudget = Math.max(1, rightCol - prefixWidth - timeWidth);
				const nameVis = visibleWidth(session.name);
				const name = nameVis > nameBudget ? truncateToWidth(session.name, nameBudget) : session.name;
				sessionLines.push(
					`${theme.fg("dim", bulletPrefix)}${theme.fg("muted", name)}${theme.fg("dim", timeSuffixRaw)}`,
				);
			}
		}
		// Pad to the fixed slot count so the box height doesn't depend on session count.
		while (sessionLines.length < WELCOME_SESSION_SLOTS) {
			sessionLines.push("");
		}

		// Right column
		const rightLines = [
			` ${theme.bold(theme.fg("accent", "Tips"))}`,
			` ${theme.fg("dim", "#")}${theme.fg("muted", " for prompt actions")}`,
			` ${theme.fg("dim", "/")}${theme.fg("muted", " for commands")}`,
			` ${theme.fg("dim", "!")}${theme.fg("muted", " to run bash")}`,
			` ${theme.fg("dim", "$")}${theme.fg("muted", " to run python")}`,
			...this.#renderLspSection(separator),
			separator,
			` ${theme.bold(theme.fg("accent", "Recent sessions"))}`,
			...sessionLines,
			"",
		];

		// Border characters (dim)
		const hChar = theme.boxRound.horizontal;
		const h = theme.fg("dim", hChar);
		const v = theme.fg("dim", theme.boxRound.vertical);
		const tl = theme.fg("dim", theme.boxRound.topLeft);
		const tr = theme.fg("dim", theme.boxRound.topRight);
		const bl = theme.fg("dim", theme.boxRound.bottomLeft);
		const br = theme.fg("dim", theme.boxRound.bottomRight);

		const lines: string[] = [];

		// Top border with embedded title
		const title = ` ${APP_NAME} v${this.version} `;
		const titlePrefixRaw = hChar.repeat(3);
		const titleStyled = theme.fg("dim", titlePrefixRaw) + theme.fg("muted", title);
		const titleVisLen = visibleWidth(titlePrefixRaw) + visibleWidth(title);
		const titleSpace = boxWidth - 2;
		if (titleVisLen >= titleSpace) {
			lines.push(tl + truncateToWidth(titleStyled, titleSpace) + tr);
		} else {
			const afterTitle = titleSpace - titleVisLen;
			lines.push(tl + titleStyled + theme.fg("dim", hChar.repeat(afterTitle)) + tr);
		}

		// Content rows
		const maxRows = showRightColumn ? Math.max(leftLines.length, rightLines.length) : leftLines.length;
		for (let i = 0; i < maxRows; i++) {
			const left = this.#fitToWidth(leftLines[i] ?? "", leftCol);
			if (showRightColumn) {
				const right = this.#fitToWidth(rightLines[i] ?? "", rightCol);
				lines.push(v + left + v + right + v);
			} else {
				lines.push(v + left + v);
			}
		}
		// Bottom border
		if (showRightColumn) {
			lines.push(bl + h.repeat(leftCol) + theme.fg("dim", theme.boxRound.teeUp) + h.repeat(rightCol) + br);
		} else {
			lines.push(bl + h.repeat(leftCol) + br);
		}

		// Randomly picked tip, rendered directly beneath the box.
		lines.push(...this.#renderTip(boxWidth));

		return lines;
	}

	/**
	 * The tip of the session wrapped to {@link TIP_MEASURE} columns (fewer when
	 * `room` is narrower); `[]` when there is none or no room for it.
	 */
	#renderLspSection(separator: string): string[] {
		if (this.lspServers === null) return [];
		const lspLines: string[] = [];
		if (this.lspServers.length === 0) {
			lspLines.push(` ${theme.fg("dim", "No LSP servers")}`);
		} else {
			for (const server of this.lspServers.slice(0, WELCOME_LSP_SLOTS)) {
				const icon =
					server.status === "ready"
						? theme.styledSymbol("status.enabled", "success")
						: server.status === "available"
							? theme.styledSymbol("status.enabled", "dim")
							: server.status === "connecting"
								? theme.styledSymbol("status.pending", "muted")
								: theme.styledSymbol("status.error", "error");
				const exts = server.fileTypes.slice(0, 3).join(" ");
				lspLines.push(` ${icon} ${theme.fg("muted", server.name)} ${theme.fg("dim", exts)}`);
			}
		}
		// Pad to the fixed slot count so the box height doesn't depend on server count.
		while (lspLines.length < WELCOME_LSP_SLOTS) {
			lspLines.push("");
		}
		return [separator, ` ${theme.bold(theme.fg("accent", "LSP Servers"))}`, ...lspLines];
	}

	#renderTip(room: number): string[] {
		const tip = this.tip;
		if (!tip) return [];
		// A trailing "[NEW]" marker paints an animated rainbow "NEW!" tag. Derive
		// its hue phase from wall-clock time so it shimmers across the welcome
		// intro's re-render frames, then settles into a still rainbow once the
		// banner caches its resting frame. Non-"[NEW]" tips ignore the phase entirely.
		const phase = NEW_TIP_MARKER.test(tip) ? performance.now() / NEW_GLOW_PERIOD_MS : 0;
		return renderWelcomeTip(tip, Math.min(room, TIP_MEASURE), phase);
	}

	/** Center text within a given width */
	#centerText(text: string, width: number): string {
		const visLen = visibleWidth(text);
		if (visLen >= width) {
			return truncateToWidth(text, width);
		}
		const leftPad = Math.floor((width - visLen) / 2);
		const rightPad = width - visLen - leftPad;
		return padding(leftPad) + text + padding(rightPad);
	}

	/** Fit string to exact width with ANSI-aware truncation/padding */
	#fitToWidth(str: string, width: number): string {
		const visLen = visibleWidth(str);
		if (visLen > width) {
			const ellipsis = "…";
			const ellipsisWidth = visibleWidth(ellipsis);
			const maxWidth = Math.max(0, width - ellipsisWidth);
			let truncated = "";
			let currentWidth = 0;
			let inEscape = false;
			for (const char of str) {
				if (char === "\x1b") inEscape = true;
				if (inEscape) {
					truncated += char;
					if (char === "m") inEscape = false;
				} else if (currentWidth < maxWidth) {
					truncated += char;
					currentWidth++;
				}
			}
			return `${truncated}${ellipsis}`;
		}
		return str + padding(width - visLen);
	}

	/** Pick the logo frame for the current intro phase, or the resting frame. */
	#currentLogoFrame(): readonly string[] {
		if (this.#animStart == null) return REST_FRAME;
		const elapsed = performance.now() - this.#animStart;
		if (elapsed >= INTRO_MS) return REST_FRAME;
		return introLogoFrame(elapsed / INTRO_MS);
	}
}

/** Block-grid brand mark shared by the welcome and setup surfaces. */
export const PI_LOGO = ["████████████", "   ██  ██   ", "   ██  ██   ", "   ▒▒  ██   ", "       ██   "];

/** Columns of {@link PI_LOGO}. */
const LOGO_WIDTH = Math.max(...PI_LOGO.map(row => row.length));

/**
 * The `omp` wordmark in half-blocks, set beside {@link PI_LOGO} from its second
 * row: the `p` descends into the fourth, the version takes the fifth.
 */
const WORDMARK = ["▄▀▀▄ █▀▄▀▄ █▀▀▄", "▀▄▄▀ █ █ █ █▄▄▀", "           █"];

/** Columns of {@link WORDMARK}. */
const WORDMARK_WIDTH = Math.max(...WORDMARK.map(row => row.length));

/** Columns between the logo and the wordmark. */
const LOCKUP_GAP = 4;

/** Widest a welcome tip wraps, so a long one stays a centered paragraph. */
const TIP_MEASURE = 72;

/** Narrowest terminal that still shows the tip; below it the banner is the logo alone. */
const TIP_MIN_COLUMNS = 50;

/** Logo frame `logo` with the wordmark beside it and `version` (styled) under the wordmark. */
function lockup(logo: readonly string[], version: string): string[] {
	const beside = ["", ...WORDMARK.map(row => theme.bold(theme.fg("text", row))), version];
	return logo.map((row, index) => `${row}${padding(LOCKUP_GAP)}${beside[index] ?? ""}`);
}

/**
 * `lines` indented as one block whose widest line is centered in `width`
 * columns; pass a single line to center it on its own.
 */
function centerBlock(lines: readonly string[], width: number): string[] {
	const widest = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	const indent = padding(Math.max(0, Math.floor((width - widest) / 2)));
	return lines.map(line => indent + line);
}

/** The block-grid brand mark as accent lines; `shimmer` declares the terminal-clocked shine sweep. */
export function logoNode(lines: readonly string[], shimmer: boolean): NativeNode {
	return col(
		lines.map(line =>
			text([span(line, "accent", shimmer ? { fx: "shimmer" } : undefined)], {
				wrap: "none",
			}),
		),
		{ align: "center", role: "omp.setup.logo" },
	);
}

/** Multi-stop palette for the diagonal gradient. */
const GRADIENT_STOPS: ReadonlyArray<readonly [number, number, number]> = [
	[248, 79, 204], // oklch(0.7 0.24 340)
	[147, 98, 244], // oklch(0.62 0.21 295)
	[0, 219, 228], // oklch(0.81 0.14 200)
];

/** 256-color ramp fallback when truecolor isn't available. */
const GRADIENT_RAMP_256 = [206, 170, 134, 99, 69, 74, 44];

/** Half-width of the shine highlight band, expressed in gradient-t units. */
const SHINE_HALF_WIDTH = 0.18;

export interface ShineConfig {
	/** Overall opacity of the shine overlay, in [0, 1]. */
	strength: number;
	/** Center of the shine band along the diagonal, in [0, 1]. */
	pos: number;
}

/**
 * Resolve the gradient SGR foreground escape for a normalized position `t`
 * (0..1) along the diagonal, compositing the optional sliding shine highlight.
 * Shared by {@link gradientLogo} and the setup splash so both stay
 * color-identical (truecolor when available, 256-color ramp otherwise).
 */
export function gradientEscape(t: number, shine?: ShineConfig): string {
	const shineStrength = shine && shine.strength > 0 ? shine.strength : 0;
	const shinePos = shine ? shine.pos : 0;
	if (TERMINAL.trueColor) {
		// 5-stop palette widens the visible color range and avoids the
		// deep-blue valley a naive HSL lerp falls into.
		const stops = GRADIENT_STOPS;
		const seg = t * (stops.length - 1);
		const i = Math.min(stops.length - 2, Math.floor(seg));
		const f = seg - i;
		const a = stops[i];
		const b = stops[i + 1];
		let r = a[0] + (b[0] - a[0]) * f;
		let g = a[1] + (b[1] - a[1]) * f;
		let bl = a[2] + (b[2] - a[2]) * f;
		if (shineStrength > 0) {
			const dist = Math.abs(t - shinePos);
			const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
			if (intensity > 0) {
				r += (255 - r) * intensity;
				g += (255 - g) * intensity;
				bl += (255 - bl) * intensity;
			}
		}
		return `\x1b[38;2;${Math.round(r)};${Math.round(g)};${Math.round(bl)}m`;
	}
	const ramp = GRADIENT_RAMP_256;
	let idx = Math.min(ramp.length - 1, Math.max(0, Math.floor(t * (ramp.length - 1) + 0.5)));
	if (shineStrength > 0) {
		const dist = Math.abs(t - shinePos);
		const intensity = Math.max(0, 1 - dist / SHINE_HALF_WIDTH) * shineStrength;
		// Promote to the brightest ramp slot when the shine band peaks here.
		if (intensity > 0.5) idx = ramp.length - 1;
	}
	return `\x1b[38;5;${ramp[idx]}m`;
}

/**
 * Apply a multi-stop diagonal gradient (top-left → bottom-right) plus an
 * optional sliding shine band across multi-line art. `phase` (0..1) shifts the
 * gradient along the diagonal, wrapping at 1. When `shine` is provided, a soft
 * white highlight is composited on top, centered at `shine.pos`.
 */
export function gradientLogo(lines: readonly string[], phase = 0, shine?: ShineConfig): string[] {
	const reset = "\x1b[0m";
	const rows = lines.length;
	const cols = Math.max(...lines.map(l => l.length));
	const xSpan = Math.max(1, cols - 1);
	const ySpan = Math.max(1, rows - 1);
	const normalizedPhase = ((phase % 1) + 1) % 1;
	return lines.map((line, y) => {
		let result = "";
		for (let x = 0; x < line.length; x++) {
			const char = line[x];
			if (char === " ") {
				result += char;
				continue;
			}
			// SVG's (0,0) → (1,1) gradient projects both normalized axes
			// equally: top-right and bottom-left land on the purple midpoint.
			const base = (x / xSpan + y / ySpan) / 2;
			const t = normalizedPhase === 0 ? base : (base + normalizedPhase) % 1;
			result += gradientEscape(t, shine) + char + reset;
		}
		return result;
	});
}

/** Total length of the intro animation. */
const INTRO_MS = 3000;
/** Render cadence during the intro (~30fps). */
const INTRO_TICK_MS = 33;
/** Number of full gradient rotations the sweep performs before settling. */
const INTRO_SWEEPS = 2.5;
/** Number of times the shine highlight crosses the diagonal across the intro. */
const INTRO_SHINE_TRAVERSALS = 3;

/**
 * Logo frame for a normalized intro progress in [0, 1).
 *
 * Ease-out cubic so the spin decelerates into the resting state. The gradient
 * sweeps backward through INTRO_SWEEPS full rotations (`eased == 1` → phase =
 * 0 = resting frame) while the shine traverses the diagonal at a steady pace,
 * decoupled from the gradient phase so the two layers parallax; its strength
 * fades with the same ease-out curve so the highlight is gone by the resting
 * frame.
 */
function introLogoFrame(progress: number): string[] {
	const eased = 1 - (1 - progress) ** 3;
	const phase = ((((1 - eased) * INTRO_SWEEPS) % 1) + 1) % 1;
	const shinePos = (((progress * INTRO_SHINE_TRAVERSALS) % 1) + 1) % 1;
	const shineStrength = (1 - eased) ** 1.5;
	return gradientLogo(PI_LOGO, phase, {
		strength: shineStrength,
		pos: shinePos,
	});
}

/** Resting gradient frame, cached for re-renders outside of the intro. */
const REST_FRAME = gradientLogo(PI_LOGO, 0);

const WELCOME_SESSION_SLOTS = 4;
const WELCOME_LSP_SLOTS = 4;
