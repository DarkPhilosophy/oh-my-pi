/**
 * Bordered output container with optional header and sections.
 */
import type { TspCardStatus, TspPreview, TspSpan, TspText, TspTone } from "@oh-my-pi/pi-wire";
import { node, span } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { ImageProtocol, TERMINAL } from "../terminal-capabilities";
import type { Theme, ThemeColor } from "../theme/theme";
import type { Component } from "../tui";
import { Ellipsis, padding, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import { getSixelLineMask } from "./sixel";
import type { State } from "./types";
import type { RenderCache } from "./utils";
import { getStateBgColor, Hasher, padToWidth } from "./utils";

/** Sections and presentation options for a bordered output block. */
export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: Array<{ label?: string; lines: readonly string[]; separator?: boolean }>;
	width: number;
	/**
	 * State the top stage (the header and every section before the first labeled one) is drawn in,
	 * independent of {@link state}. A card whose command is final while its output still runs sets this so
	 * the final stage keeps the same bytes through every later state change; `state` then colours only
	 * the live stage that starts at the first labeled section. It also keeps the block at the full row
	 * width, overriding {@link fitToContent}, so no later row can move the top stage's bytes.
	 */
	stageTone?: State;
	/**
	 * Narrowest the lower box may be. A caller that re-renders the same card as output streams passes the
	 * widest lower box it has drawn, so the box only ever grows and its right border never jumps back.
	 */
	minLiveWidth?: number;
	applyBg?: boolean;
	contentPaddingLeft?: number;
	contentPaddingRight?: number;
	/** Override the state-derived border color. Used for muted "legacy" tool
	 * frames that should not visually compete with framed-output tools. */
	borderColor?: ThemeColor;
	/**
	 * When true, the block hugs its content (longest line or header, plus
	 * borders/padding) instead of spanning the full row — but only while the
	 * natural width stays below 60% of the given `width`. Wide content (diffs,
	 * long lines) keeps the full row so it stays readable.
	 */
	fitToContent?: boolean;
}

const FRAMED_BLOCK_COMPONENT = Symbol("framedBlockComponent");

/** A component marked as rendering its own output frame. */
export type FramedBlockComponent = Component & { [FRAMED_BLOCK_COMPONENT]?: true };

/** Mark a component as owning its output frame. */
export function markFramedBlockComponent<T extends Component>(component: T): T & FramedBlockComponent {
	(component as T & FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] = true;
	return component as T & FramedBlockComponent;
}

/** Return whether a component owns its output frame. */
export function isFramedBlockComponent(component: Component): boolean {
	return (component as FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] === true;
}

type BlockRow = { live: boolean } & (
	| { kind: "bar"; leftChar: string; rightChar: string; label?: string; meta?: string }
	| { kind: "bottom"; leftChar: string; rightChar: string }
	| { kind: "content"; inner: string }
	| { kind: "sixel"; raw: string }
);

function normalizeContentPaddingLeft(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 1;
	return Math.max(0, Math.floor(value));
}

/**
 * Inner content width that {@link renderOutputBlock} wraps its body to, for a
 * given outer `width`: both vertical borders plus symmetric content padding.
 * An explicit left padding of zero keeps legacy flush blocks flush on both
 * sides unless a right padding is provided separately.
 */
export function outputBlockContentWidth(
	width: number,
	contentPaddingLeft?: number,
	contentPaddingRight?: number,
): number {
	const left = normalizeContentPaddingLeft(contentPaddingLeft);
	const right = normalizeContentPaddingLeft(contentPaddingRight ?? left);
	return Math.max(1, width - 2 - left - right);
}

/** Render a bordered output block with optional header and sections. */
export function renderOutputBlock(options: OutputBlockOptions, theme: Theme): string[] {
	return renderOutputBlockStaged(options, theme).lines;
}

/** Rendered rows plus how many leading rows belong to the top stage (the rows before the first live row). */
export interface StagedOutputBlock {
	lines: string[];
	/** Leading rows only the live stage's changes cannot alter; 0 when the block has no stage tone. */
	topStageRows: number;
	/** Width the lower box was drawn at; 0 when the block has no stage tone. */
	liveWidth: number;
}

/** {@link renderOutputBlock} that also reports the top stage's row count. */
export function renderOutputBlockStaged(options: OutputBlockOptions, theme: Theme): StagedOutputBlock {
	const { header, headerMeta, state, sections = [], width, applyBg = true } = options;
	const h = theme.boxRound.horizontal;
	const v = theme.boxRound.vertical;
	const cap = h.repeat(3);
	// Index of the first labeled section: it starts the live stage; everything before it is the top stage.
	const labeled = sections.findIndex(section => section.label !== undefined);
	const firstLiveSection = labeled < 0 ? sections.length : labeled;

	// fitToContent: measure the natural width of header + body before wrapping.
	// Wrap must happen against the *natural* content width or short lines would
	// be measured post-wrap and the box could never narrow.
	let lineWidth = Math.max(0, width);
	// A staged block is two boxes, each as wide as its own content (see `stageWidths`): the top stage
	// never depends on the live stage, so its bytes survive whatever the output does.
	const staged = options.stageTone !== undefined;
	if (options.fitToContent && !staged) {
		const padL = normalizeContentPaddingLeft(options.contentPaddingLeft);
		const padR = normalizeContentPaddingLeft(options.contentPaddingRight ?? options.contentPaddingLeft);
		const overhead = visibleWidth(v) * 2 + padL + padR;
		const headerWidth =
			header || headerMeta
				? visibleWidth(` ${[header, headerMeta].filter(Boolean).join(theme.sep.dot)} `) +
					visibleWidth(cap) +
					visibleWidth(cap)
				: 0;
		let bodyWidth = 0;
		for (const section of sections) {
			for (const line of section.lines) {
				for (const raw of line.split("\n")) {
					bodyWidth = Math.max(bodyWidth, visibleWidth(raw.trimEnd()));
				}
			}
		}
		const natural = Math.min(lineWidth, Math.max(headerWidth, bodyWidth + overhead));
		// Only narrow when the content is comfortably below the row; wide content
		// keeps the full width so long lines wrap against the real row, not a
		// shrunken box.
		if (natural < lineWidth * 0.6) lineWidth = natural;
	}
	// Border colors: running/pending use accent, success uses dim (gray), error/warning keep their colors
	const colorsFor = (frameState: State | undefined) => {
		const borderColor: ThemeColor =
			options.borderColor ??
			(frameState === "error"
				? "error"
				: frameState === "warning"
					? "warning"
					: frameState === "running" || frameState === "pending"
						? "accent"
						: "dim");
		const border = (text: string) => theme.fg(borderColor, text);
		const bgFn = (() => {
			if (!frameState || !applyBg) return undefined;
			const bgAnsi = theme.getBgAnsi(getStateBgColor(frameState));
			// Keep block background stable even if inner content contains SGR resets (e.g. "\x1b[0m"),
			// which would otherwise clear the outer background mid-line.
			return (text: string) => {
				const stabilized = text
					.replace(/\x1b\[(?:0)?m/g, m => `${m}${bgAnsi}`)
					.replace(/\x1b\[49m/g, m => `${m}${bgAnsi}`);
				return `${bgAnsi}${stabilized}\x1b[49m`;
			};
		})();
		return { border, bgFn };
	};
	const topColors = colorsFor(options.stageTone ?? state);
	const liveColors = colorsFor(state);
	// Rows are painted in the colours of their stage; without a stage tone both are the same.
	let border = topColors.border;
	let bgFn = topColors.bgFn;

	const contentPaddingLeft = normalizeContentPaddingLeft(options.contentPaddingLeft);
	const contentPaddingRight = normalizeContentPaddingLeft(options.contentPaddingRight ?? contentPaddingLeft);
	const contentWidth = Math.max(
		0,
		lineWidth - visibleWidth(v) - contentPaddingLeft - contentPaddingRight - visibleWidth(v),
	);
	const contentLeftPadding = contentPaddingLeft > 0 ? padding(contentPaddingLeft) : "";
	const contentRightPadding = contentPaddingRight > 0 ? padding(contentPaddingRight) : "";

	// Per-stage widths. Unstaged blocks have one width. A staged block's top box fits its header and code
	// (never wider than the row, never narrower than what its own rows need); the live box fits its
	// output, floored at the top box so the two always overlap, and capped at the row.
	const frameOverhead = visibleWidth(v) * 2 + contentPaddingLeft + contentPaddingRight;
	const stageWidth = (list: typeof sections, withHeader: boolean): number => {
		let body = 0;
		for (const section of list) {
			for (const line of section.lines) {
				for (const raw of line.split("\n")) body = Math.max(body, visibleWidth(raw.trimEnd()));
			}
		}
		const head =
			withHeader && (header || headerMeta)
				? visibleWidth(` ${[header, headerMeta].filter(Boolean).join(theme.sep.dot)} `) +
					visibleWidth(cap) +
					visibleWidth(cap)
				: 0;
		return Math.min(Math.max(0, width), Math.max(head, body + frameOverhead));
	};
	const topNatural = staged ? stageWidth(sections.slice(0, firstLiveSection), true) : lineWidth;
	// The top box is sized from its own header and code only: the separator label belongs to the live
	// stage and changes with the run state, so it may never move the top box.
	const topWidth = topNatural;
	// The lower box must at least hold its own separator label (`├─── Output Running ───`) and its corners;
	// below that the label would be cut mid-word.
	const liveLabelWidth = staged
		? Math.max(
				0,
				...sections
					.slice(firstLiveSection)
					.filter(section => section.label !== undefined)
					// corner + cap + ` label ` + one fill + tee + closing corner
					.map(section => 1 + visibleWidth(cap) + visibleWidth(` ${section.label} `) + 3),
			)
		: 0;
	const liveWidth = staged
		? Math.max(stageWidth(sections.slice(firstLiveSection), false), liveLabelWidth, options.minLiveWidth ?? 0)
		: lineWidth;
	const liveFitted = staged ? Math.min(Math.max(width, 0), Math.max(liveWidth, visibleWidth(cap) + 2)) : lineWidth;
	// A one- or two-column step between the boxes reads as a rendering glitch rather than a deliberate
	// join, so near-equal boxes share a width. Snap the lower box to the top one, but never below what
	// its own content and label need.
	const NEAR_EQUAL_COLUMNS = 2;
	const liveSnapped = Math.max(
		staged && liveFitted !== topWidth && Math.abs(liveFitted - topWidth) <= NEAR_EQUAL_COLUMNS
			? Math.min(Math.max(width, 0), Math.max(topWidth, liveFitted))
			: liveFitted,
		staged ? Math.min(Math.max(width, 0), liveLabelWidth) : 0,
	);
	const rowWidth = (live: boolean): number => (staged ? (live ? liveSnapped : topWidth) : lineWidth);

	// ── Layout pass: collect row descriptors before emitting the bordered lines. ──
	const rows: BlockRow[] = [];
	rows.push({
		live: false,
		kind: "bar",
		leftChar: theme.boxRound.topLeft,
		rightChar: theme.boxRound.topRight,
		label: header,
		meta: headerMeta,
	});

	const normalizedSections = sections.length > 0 ? sections : [{ lines: [] as string[] }];
	for (let sectionIndex = 0; sectionIndex < normalizedSections.length; sectionIndex++) {
		const section = normalizedSections[sectionIndex]!;
		const live = sectionIndex >= firstLiveSection;
		// A labeled section always draws its titled separator bar. A label-less
		// section can still request a plain divider via `separator`, but only
		// between sections — leading with one would just double the header bar.
		if (section.label) {
			rows.push({
				live,
				kind: "bar",
				leftChar: theme.boxRound.teeRight,
				rightChar: theme.boxRound.teeLeft,
				label: section.label,
			});
		} else if (section.separator && sectionIndex > 0) {
			rows.push({
				live,
				kind: "bar",
				leftChar: theme.boxRound.teeRight,
				rightChar: theme.boxRound.teeLeft,
			});
		}
		const allLines = section.lines.flatMap(l => l.split("\n"));
		const sixelLineMask = TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(allLines) : undefined;
		for (let lineIndex = 0; lineIndex < allLines.length; lineIndex++) {
			const line = allLines[lineIndex]!;
			if (sixelLineMask?.[lineIndex]) {
				rows.push({ live, kind: "sixel", raw: line });
				continue;
			}
			const stageContent = Math.max(0, rowWidth(live) - frameOverhead);
			const wrapAt = staged ? stageContent : contentWidth;
			const wrappedLines = wrapTextWithAnsi(line.trimEnd(), wrapAt);
			for (const wrappedLine of wrappedLines) {
				const innerPadding = padding(Math.max(0, wrapAt - visibleWidth(wrappedLine)));
				rows.push({ live, kind: "content", inner: `${wrappedLine}${innerPadding}` });
			}
		}
	}

	rows.push({
		// The closing border belongs to the lower box only when there is one. Before execution starts the
		// block is just the command box, and a bottom sized for an absent lower stage is a few columns wide.
		live: staged && firstLiveSection < sections.length,
		kind: "bottom",
		leftChar: theme.boxRound.bottomLeft,
		rightChar: theme.boxRound.bottomRight,
	});

	const H = rows.length;

	const renderBar = (
		row: { leftChar: string; rightChar: string; label?: string; meta?: string },
		lineWidth: number,
	): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		if (lineWidth <= 0) return border(leftGlyphs) + border(rightGlyph);
		const labelText = [row.label, row.meta].filter(Boolean).join(theme.sep.dot);
		if (!labelText) {
			// No header: draw a clean, continuous top/separator bar (no 1-col gap).
			const fillCount = Math.max(0, lineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
			return `${border(leftGlyphs)}${border(h.repeat(fillCount))}${border(rightGlyph)}`;
		}
		const rawLabel = ` ${labelText} `;
		const leftWidth = visibleWidth(leftGlyphs);
		const rightWidth = visibleWidth(rightGlyph);
		const maxLabelWidth = Math.max(0, lineWidth - leftWidth - rightWidth);
		const trimmedLabel = truncateToWidth(rawLabel, maxLabelWidth);
		const labelWidth = visibleWidth(trimmedLabel);
		const fillCount = Math.max(0, lineWidth - leftWidth - labelWidth - rightWidth);
		const fillGlyphs = h.repeat(fillCount);
		return `${border(leftGlyphs)}${trimmedLabel}${border(fillGlyphs)}${border(rightGlyph)}`;
	};

	const renderBottom = (row: { leftChar: string; rightChar: string }, lineWidth: number): string => {
		const leftGlyphs = `${row.leftChar}${cap}`;
		const rightGlyph = row.rightChar;
		const fillCount = Math.max(0, lineWidth - visibleWidth(leftGlyphs) - visibleWidth(rightGlyph));
		const fillGlyphs = h.repeat(fillCount);
		return `${border(leftGlyphs)}${border(fillGlyphs)}${border(rightGlyph)}`;
	};

	const renderContent = (inner: string): string =>
		`${border(v)}${contentLeftPadding}${inner}${contentRightPadding}${border(v)}`;

	const clipFrame = lineWidth < Math.max(visibleWidth(cap) + 2, contentPaddingLeft + contentPaddingRight + 2);
	// The connector is the first live bar. It spans the wider box and carries a tee where the narrower
	// one ends: `┴` closes the top box inside a wider lower box, `┬` opens the lower box inside a wider
	// top box. Equal widths draw the ordinary separator.
	const connectorIndex = staged ? rows.findIndex(row => row.live && row.kind === "bar") : -1;
	const renderConnector = (row: { label?: string; meta?: string }): string => {
		const wide = Math.max(topWidth, liveSnapped);
		const labelText = [row.label, row.meta].filter(Boolean).join(theme.sep.dot);
		const leftGlyphs = `${theme.boxRound.teeRight}${cap}`;
		const label = truncateToWidth(
			labelText ? ` ${labelText} ` : "",
			Math.max(0, wide - visibleWidth(leftGlyphs) - 1),
		);
		if (topWidth === liveSnapped) {
			// Same width: an ordinary separator, no jog.
			const fill = Math.max(0, wide - visibleWidth(leftGlyphs) - visibleWidth(label) - 1);
			// The label brings its own foreground reset, so every border segment is coloured on its own
			// (as renderBar does); one border() around the row would leave all text after the label uncoloured.
			return `${border(leftGlyphs)}${label}${border(`${h.repeat(fill)}${theme.boxRound.teeLeft}`)}`;
		}
		const lowerIsWider = liveSnapped > topWidth;
		// The tee marks where the top box ends (lower wider) or where the lower box ends (top wider). A label
		// that runs past that column pushes the tee to the label's end; the row is live, so it may move.
		const edge = Math.min(topWidth, liveSnapped) - 1;
		const afterLabel = visibleWidth(leftGlyphs) + visibleWidth(label);
		const teeColumn = Math.max(edge, afterLabel);
		const tee = lowerIsWider ? "\u2534" : "\u252c";
		const close = lowerIsWider ? theme.boxRound.topRight : theme.boxRound.bottomRight;
		const beforeTee = Math.max(0, teeColumn - afterLabel);
		const afterTee = Math.max(0, wide - 1 - teeColumn - 1);
		return `${border(leftGlyphs)}${label}${border(`${h.repeat(beforeTee)}${tee}${h.repeat(afterTee)}${close}`)}`;
	};

	const lines: string[] = [];
	for (let r = 0; r < H; r++) {
		const row = rows[r]!;
		const colors = row.live ? liveColors : topColors;
		border = colors.border;
		bgFn = colors.bgFn;
		if (row.kind === "sixel") {
			lines.push(row.raw);
			continue;
		}
		const widthHere = r === connectorIndex ? Math.max(topWidth, liveSnapped) : rowWidth(row.live);
		const line =
			r === connectorIndex && row.kind === "bar"
				? renderConnector(row)
				: row.kind === "bar"
					? renderBar(row, widthHere)
					: row.kind === "bottom"
						? renderBottom(row, widthHere)
						: renderContent(row.inner);
		const clip = staged
			? widthHere < Math.max(visibleWidth(cap) + 2, contentPaddingLeft + contentPaddingRight + 2)
			: clipFrame;
		lines.push(padToWidth(clip ? truncateToWidth(line, widthHere, Ellipsis.Omit) : line, widthHere, bgFn));
	}

	const firstLive = rows.findIndex(row => row.live);
	return {
		lines,
		topStageRows: options.stageTone === undefined ? 0 : firstLive < 0 ? rows.length : firstLive,
		liveWidth: staged ? liveSnapped : 0,
	};
}

/** Card tone for an output state. */
export function outputStateTone(state: State | undefined): TspTone {
	switch (state) {
		case "pending":
		case "running":
			return "pending";
		case "success":
			return "success";
		case "error":
			return "error";
		case "warning":
			return "warning";
		default:
			return "neutral";
	}
}

/** Card status chip for an output state. */
export function outputStateStatus(state: State | undefined): TspCardStatus | undefined {
	switch (state) {
		case "pending":
			return "pending";
		case "running":
			return "running";
		case "success":
		case "warning":
			return "done";
		case "error":
			return "error";
		default:
			return undefined;
	}
}

/** One body section of a native output block. */
export interface NativeOutputBlockSection {
	/** Titled sub-section (the ANSI path's labelled separator bar). */
	label?: TspText;
	body: readonly NativeChild[];
	/** Divide from the previous section with a rule. */
	separator?: boolean;
	/** Stable identity when sections come and go. */
	key?: string;
}

/** Semantic inputs for {@link describeOutputBlock}. */
export interface NativeOutputBlockOptions {
	head?: TspText;
	meta?: TspText;
	state?: State;
	/** Card role (`omp.tool.bash`, `omp.eval.cell`, …). Defaults to `omp.output`. */
	role?: string;
	/** Override the state-derived tone (the ANSI path's `borderColor`). */
	tone?: TspTone;
	sections?: readonly NativeOutputBlockSection[];
	collapsible?: boolean;
	collapsed?: boolean;
	preview?: TspPreview;
	/** Flat card without a ring (inline/plain variants). */
	inset?: boolean;
	key?: string;
}

function asSpans(content: TspText): readonly TspSpan[] {
	return typeof content === "string" ? [span(content)] : content;
}

/**
 * The native form of {@link renderOutputBlock}: a `card` whose tone and
 * status chip come from the state, head from the header plus meta, and body
 * from the sections (labelled ones as `section`s, separators as `rule`s).
 * Borders, background fills and wrapping are the terminal's.
 */
export function describeOutputBlock(options: NativeOutputBlockOptions): NativeNode {
	let head: TspText | undefined = options.head;
	if (options.meta !== undefined && options.meta !== "") {
		head = head === undefined ? options.meta : [...asSpans(head), span(" · ", "dim"), ...asSpans(options.meta)];
	}
	const children: NativeChild[] = [];
	const sections = options.sections ?? [];
	for (let index = 0; index < sections.length; index++) {
		const section = sections[index]!;
		const key = section.key ?? String(index);
		if (section.label !== undefined) {
			children.push(node("section", { head: section.label }, section.body, key));
			continue;
		}
		if (section.separator && index > 0) children.push(node("rule", undefined, undefined, `${key}:rule`));
		for (const child of section.body) children.push(child);
	}
	return node(
		"card",
		{
			role: options.role ?? "omp.output",
			tone: options.tone ?? outputStateTone(options.state),
			status: outputStateStatus(options.state),
			head,
			collapsible: options.collapsible,
			collapsed: options.collapsed,
			preview: options.preview,
			inset: options.inset,
		},
		children,
		options.key,
	);
}

/**
 * Cached wrapper around `renderOutputBlock`.
 *
 * Since output blocks are re-rendered on every frame (via `render(width)` closures),
 * but their content rarely changes, this cache avoids redundant `visibleWidth()` and
 * `padding()` computations on ~99% of render calls.
 */
export class CachedOutputBlock {
	#cache?: RenderCache;
	#lastOptions?: OutputBlockOptions;
	#topStageRows = 0;
	#liveWidth = 0;

	/** Rows of the top stage in the most recent render (see {@link StagedOutputBlock}). */
	get topStageRows(): number {
		return this.#topStageRows;
	}

	/** Width of the lower box in the most recent render (see {@link StagedOutputBlock}). */
	get liveWidth(): number {
		return this.#liveWidth;
	}

	/** Render with caching. Returns the cached (shared, caller-immutable) lines if options haven't changed. */
	render(options: OutputBlockOptions, theme: Theme): readonly string[] {
		// Reference fast path: rebuild paths often hand back the same options
		// object when nothing changed; skip the full content hash entirely.
		if (this.#lastOptions === options && this.#cache) return this.#cache.lines;
		const key = this.#buildKey(options);
		if (this.#cache?.key === key) {
			this.#lastOptions = options;
			return this.#cache.lines;
		}
		const staged = renderOutputBlockStaged(options, theme);
		this.#cache = { key, lines: staged.lines };
		this.#topStageRows = staged.topStageRows;
		this.#liveWidth = staged.liveWidth;
		this.#lastOptions = options;
		return staged.lines;
	}

	/** Invalidate the cache, forcing a rebuild on next render. */
	invalidate(): void {
		this.#cache = undefined;
		this.#lastOptions = undefined;
		this.#topStageRows = 0;
	}

	#buildKey(options: OutputBlockOptions): bigint {
		const h = new Hasher();
		h.u32(options.width);
		h.u32(normalizeContentPaddingLeft(options.contentPaddingLeft));
		h.u32(
			normalizeContentPaddingLeft(
				options.contentPaddingRight ?? normalizeContentPaddingLeft(options.contentPaddingLeft),
			),
		);
		h.optional(options.header);
		h.optional(options.headerMeta);
		h.optional(options.state);
		h.optional(options.stageTone);
		h.u32(options.minLiveWidth ?? 0);
		h.optional(options.borderColor);
		h.bool(options.applyBg ?? true);
		h.bool(options.fitToContent ?? false);
		if (options.sections) {
			for (const s of options.sections) {
				h.optional(s.label);
				h.bool(s.separator ?? false);
				h.u64(sectionLinesDigest(s.lines));
			}
		}
		return h.digest();
	}
}

/**
 * Digest of one section's lines, memoized by array identity. Callers hand a
 * fresh options object to every render, so the reference fast path above
 * rarely hits, and hashing every output line on every frame was a measurable
 * share of a streaming tool card's paint. The line arrays themselves are
 * usually reused between frames, so their digest can be.
 */
const sectionDigests = new WeakMap<readonly string[], bigint>();
function sectionLinesDigest(lines: readonly string[]): bigint {
	const memo = sectionDigests.get(lines);
	if (memo !== undefined) return memo;
	const h = new Hasher();
	for (const line of lines) h.str(line);
	const digest = h.digest();
	sectionDigests.set(lines, digest);
	return digest;
}
