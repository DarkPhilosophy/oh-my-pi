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
import { formatEarlierLines, formatExpandHint } from "./render-utils";

/** Sections and presentation options for a bordered output block. */
export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	/** Facts drawn inside the bottom border (`╰── Wall 0.16s · Timeout 300s ──╯`). */
	footerMeta?: string;
	/** Short control aligned to the right of the bottom border, omitted when it cannot fit. */
	footerAction?: string;
	state?: State;
	sections?: Array<{ label?: string; lines: readonly string[]; separator?: boolean; separatorAction?: string }>;
	width: number;
	/**
	 * State the top stage (the header and every section before the first labeled one) is drawn in,
	 * independent of {@link state}. A card whose command is final while its output still runs sets this so
	 * the final stage keeps the same bytes through every later state change. Set `state` to give the
	 * live stage its own colours; otherwise both stages share this tone. Each stage sizes independently
	 * so no live row can move the top stage's bytes.
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
	| { kind: "bar"; leftChar: string; rightChar: string; label?: string; meta?: string; action?: string }
	| { kind: "bottom"; leftChar: string; rightChar: string; meta?: string; action?: string }
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

/** A bounded, framed context preview for renderers without their own row budget. */
export function renderOutputBlockViewport(
	header: string,
	lines: readonly string[],
	width: number,
	maxRows: number,
	theme: Theme,
	keepSectionDivider = false,
): readonly string[] | undefined {
	if (maxRows < 3 || width < 5 || lines.some(line => TERMINAL.isImageLine(line))) return undefined;
	const firstRow = Bun.stripANSI(lines[0] ?? "");
	const first = firstRow.trimStart();
	const framed = first.startsWith(theme.boxRound.topLeft) || first.startsWith(theme.boxRound.teeRight);
	const indent = framed ? visibleWidth(firstRow) - visibleWidth(first) : 0;
	const last = Bun.stripANSI(lines.at(-1) ?? "").trimEnd();
	if (framed && !last.trimStart().startsWith(theme.boxRound.bottomLeft)) return undefined;
	const frameWidth = framed ? Math.min(width - indent, visibleWidth(last) - indent) : width;
	const contentWidth = outputBlockContentWidth(frameWidth, 0, 0);
	const body: string[] = [];
	let earlierHidden = 0;
	let vagueElision = false;
	let divider: string | undefined;
	let inputRows = 0;
	for (const line of lines) {
		const plain = Bun.stripANSI(line);
		const trimmed = plain.trim();
		if (!trimmed) continue;
		let content = line;
		if (framed) {
			if (
				keepSectionDivider &&
				maxRows >= 4 &&
				divider === undefined &&
				line !== lines[0] &&
				trimmed.startsWith(theme.boxRound.teeRight)
			) {
				divider = line;
				inputRows = body.length;
				continue;
			}
			if (!trimmed.startsWith(theme.boxRound.vertical) || !trimmed.endsWith(theme.boxRound.vertical)) continue;
			// Inspect plain content, but keep the renderer's ANSI row intact.
			// Slicing its glyph columns can reorder inherited SGR colors.
			content = trimmed.slice(theme.boxRound.vertical.length, -theme.boxRound.vertical.length);
		}
		const text = Bun.stripANSI(content).trim();
		if (!text) continue;
		// Strip only structural gutters, not arbitrary source text containing a marker.
		let markerContent = text;
		while (theme.tree.vertical && markerContent.startsWith(theme.tree.vertical)) {
			markerContent = markerContent.slice(theme.tree.vertical.length).trimStart();
		}
		const elision = /^… \((\d+) earlier lines?\b/u.exec(markerContent);
		if (elision) {
			earlierHidden += Number(elision[1]);
			continue;
		}
		// Legacy or count-free elision markers collapse into the single marker
		// instead of stacking a second one below it.
		if (markerContent.startsWith("… (earlier")) {
			vagueElision = true;
			continue;
		}
		body.push(framed ? line : truncateToWidth(content, contentWidth));
	}
	if (body.length === 0) return undefined;
	const slots = maxRows - 2 - (divider === undefined ? 0 : 1);
	const needsMarker = earlierHidden > 0 || vagueElision || body.length > slots;
	const showMarker = needsMarker && slots > 1;
	if (needsMarker && !showMarker && divider === undefined) return undefined;
	const visibleCount = slots - (showMarker ? 1 : 0);
	// Keep the newest output, then spend any spare rows on the end of the command.
	const inputSlots = Math.max(0, visibleCount - (body.length - inputRows));
	const visibleInput = divider === undefined ? [] : body.slice(Math.max(0, inputRows - inputSlots), inputRows);
	const visibleOutput =
		divider === undefined
			? body.slice(-visibleCount)
			: body.slice(Math.max(inputRows, body.length - (visibleCount - visibleInput.length)));
	const hidden = earlierHidden + body.length - visibleInput.length - visibleOutput.length;
	const markerText = vagueElision
		? `… (earlier lines hidden, showing ${visibleInput.length + visibleOutput.length})`
		: formatEarlierLines({ hidden, shown: visibleInput.length + visibleOutput.length });
	const marker = `${theme.fg("dim", markerText)} ${formatExpandHint(theme)}`;
	if (framed) {
		const sample = visibleInput[0] ?? visibleOutput[0];
		const markerRows: string[] = [];
		if (showMarker && sample) {
			const firstBorder = sample.indexOf(theme.boxRound.vertical);
			const lastBorder = sample.lastIndexOf(theme.boxRound.vertical);
			const bodyWidth = visibleWidth(sample.slice(firstBorder, lastBorder)) - 1;
			const label = truncateToWidth(marker, bodyWidth);
			const borderStyle = /(?:\x1b\[[0-9;:]*m)*$/.exec(sample.slice(0, lastBorder))?.[0] ?? "";
			markerRows.push(
				sample.slice(0, firstBorder + theme.boxRound.vertical.length) +
					"\x1b[39m" +
					label +
					padding(Math.max(0, bodyWidth - visibleWidth(label))) +
					borderStyle +
					sample.slice(lastBorder) +
					"\x1b[0m",
			);
		}
		return [
			lines[0]!,
			...(visibleInput.length > 0 ? markerRows : []),
			...visibleInput,
			...(divider === undefined ? [] : [divider]),
			...(visibleInput.length === 0 ? markerRows : []),
			...visibleOutput,
			lines.at(-1)!,
		];
	}
	const rendered = renderOutputBlock(
		{
			header,
			width: frameWidth,
			applyBg: false,
			contentPaddingLeft: 0,
			contentPaddingRight: 0,
			sections: [{ lines: showMarker ? [truncateToWidth(marker, contentWidth), ...visibleOutput] : visibleOutput }],
		},
		theme,
	);
	return rendered;
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
	const liveColors = state === undefined || state === options.stageTone ? topColors : colorsFor(state);
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
	const firstLive = sections[firstLiveSection];
	const labelWidth = firstLive?.label ? visibleWidth(` ${firstLive.label} `) : 0;
	const actionWidth = firstLive?.separatorAction ? visibleWidth(`${firstLive.separatorAction}${h}`) : 0;
	const labelOnRight = labelWidth > 0 && labelWidth + visibleWidth(cap) + 2 > topWidth;
	// The tee must stay under the already-painted command edge. When its right
	// rail carries the status or a copy control, leave room for that whole segment.
	const rightContentWidth = (labelOnRight ? labelWidth : 0) + actionWidth;
	const rightSegmentWidth = rightContentWidth > 0 ? rightContentWidth + 2 : 0;
	// The lower box must at least hold its own separator label (`├─── Output Running ───`) and its corners;
	// below that the label would be cut mid-word.
	const liveLabelWidth = staged
		? Math.max(
				0,
				...sections
					.slice(firstLiveSection)
					.filter(section => section.label !== undefined)
					.map(
						section =>
							2 +
							visibleWidth(`${cap} ${section.label} `) +
							(section.separatorAction ? visibleWidth(`${section.separatorAction}${h}`) : 0),
					),
			)
		: 0;
	// The closing border of the lower box carries its facts and optional right-aligned action.
	const footerEdges = visibleWidth(`${theme.boxRound.bottomLeft}${cap}${theme.boxRound.bottomRight}`);
	const footerMetaWidth = options.footerMeta === undefined ? 0 : visibleWidth(` ${options.footerMeta} `);
	const footerActionWidth = options.footerAction === undefined ? 0 : visibleWidth(`${options.footerAction}${h}`);
	const liveFooterWidth =
		staged && firstLiveSection < sections.length && (footerMetaWidth > 0 || footerActionWidth > 0)
			? footerEdges + footerMetaWidth + footerActionWidth
			: 0;
	const liveWidth = staged
		? Math.max(
				stageWidth(sections.slice(firstLiveSection), false),
				liveLabelWidth,
				liveFooterWidth,
				options.minLiveWidth ?? 0,
			)
		: lineWidth;
	const liveFitted = staged ? Math.min(Math.max(width, 0), Math.max(liveWidth, visibleWidth(cap) + 2)) : lineWidth;
	// The live result continues the command frame. It may widen for output,
	// but must not collapse into a separate narrow box below the frozen head.
	const liveSnapped = Math.max(
		liveFitted,
		staged ? topWidth : 0,
		staged ? Math.min(Math.max(width, 0), liveLabelWidth) : 0,
	);
	const splitWidth =
		staged && liveSnapped > topWidth && topWidth + rightSegmentWidth <= lineWidth
			? Math.max(liveSnapped, topWidth + rightSegmentWidth)
			: liveSnapped;
	const liveContentWidth = Math.max(0, splitWidth - frameOverhead);
	const dividerInBody =
		staged &&
		splitWidth > topWidth &&
		rightSegmentWidth > splitWidth - topWidth &&
		(labelOnRight || labelWidth + actionWidth <= liveContentWidth);
	const rowWidth = (live: boolean): number => (staged ? (live ? splitWidth : topWidth) : lineWidth);

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
			const inBody = sectionIndex === firstLiveSection && dividerInBody;
			rows.push({
				live,
				kind: "bar",
				leftChar: theme.boxRound.teeRight,
				rightChar: theme.boxRound.teeLeft,
				label: inBody ? undefined : section.label,
				action: inBody ? undefined : section.separatorAction,
			});
			if (inBody && liveContentWidth > 0) {
				if (section.separatorAction && labelWidth + actionWidth <= liveContentWidth) {
					const gap = liveContentWidth - visibleWidth(section.label) - visibleWidth(section.separatorAction);
					rows.push({ live, kind: "content", inner: `${section.label}${padding(gap)}${section.separatorAction}` });
				} else {
					for (const line of wrapTextWithAnsi(section.label, liveContentWidth)) {
						rows.push({ live, kind: "content", inner: line + padding(liveContentWidth - visibleWidth(line)) });
					}
				}
			}
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

	// The closing border belongs to the lower box only when there is one. Before execution starts the
	// block is just the command box, and a bottom sized for an absent lower stage is a few columns wide.
	const bottomLive = staged && firstLiveSection < sections.length;
	const bottomWidth = rowWidth(bottomLive);
	// Footer facts ride the bottom border only when they fit whole; a clipped
	// border would silently drop trailing facts (exit code, artifact id), so an
	// overflowing footer wraps into body rows above a plain border instead.
	const footerMeta = options.footerMeta;
	const footerRoom = bottomWidth - footerEdges;
	const footerAction = footerActionWidth <= footerRoom ? options.footerAction : undefined;
	const footerFits = footerMetaWidth + (footerAction === undefined ? 0 : footerActionWidth) <= footerRoom;
	if (footerMeta !== undefined && !footerFits) {
		const footerWrapAt = staged ? Math.max(0, bottomWidth - frameOverhead) : contentWidth;
		for (const wrappedLine of wrapTextWithAnsi(footerMeta, footerWrapAt)) {
			const innerPadding = padding(Math.max(0, footerWrapAt - visibleWidth(wrappedLine)));
			rows.push({ live: bottomLive, kind: "content", inner: `${wrappedLine}${innerPadding}` });
		}
	}
	rows.push({
		live: bottomLive,
		kind: "bottom",
		leftChar: theme.boxRound.bottomLeft,
		rightChar: theme.boxRound.bottomRight,
		meta: footerFits ? footerMeta : undefined,
		action: footerAction,
	});

	const H = rows.length;

	const renderBar = (
		row: { leftChar: string; rightChar: string; label?: string; meta?: string; action?: string },
		lineWidth: number,
		lead = cap,
	): string => {
		const leftGlyphs = `${row.leftChar}${lead}`;
		const labelText = [row.label, row.meta].filter(Boolean).join(theme.sep.dot);
		const action =
			row.action &&
			visibleWidth(`${leftGlyphs}${labelText ? ` ${labelText} ` : ""}${row.action}${h}${row.rightChar}`) <= lineWidth
				? row.action
				: undefined;
		const rightGlyph = row.rightChar;
		const right = action === undefined ? border(rightGlyph) : action + border(`${h}${rightGlyph}`);
		const rightWidth = visibleWidth(right);
		if (lineWidth <= 0) return border(leftGlyphs) + border(rightGlyph);
		if (!labelText) {
			// No header: draw a clean, continuous top/separator bar (no 1-col gap).
			const fillCount = Math.max(0, lineWidth - visibleWidth(leftGlyphs) - rightWidth);
			return `${border(leftGlyphs)}${border(h.repeat(fillCount))}${right}`;
		}
		const rawLabel = ` ${labelText} `;
		const leftWidth = visibleWidth(leftGlyphs);
		const maxLabelWidth = Math.max(0, lineWidth - leftWidth - rightWidth);
		const trimmedLabel = truncateToWidth(rawLabel, maxLabelWidth);
		const labelWidth = visibleWidth(trimmedLabel);
		const fillCount = Math.max(0, lineWidth - leftWidth - labelWidth - rightWidth);
		const fillGlyphs = h.repeat(fillCount);
		return `${border(leftGlyphs)}${trimmedLabel}${border(fillGlyphs)}${right}`;
	};

	const renderContent = (inner: string): string =>
		`${border(v)}${contentLeftPadding}${inner}${contentRightPadding}${border(v)}`;

	const clipFrame = lineWidth < Math.max(visibleWidth(cap) + 2, contentPaddingLeft + contentPaddingRight + 2);
	// The first live bar joins the boxes. The live box is never narrower than the
	// command, so unequal widths close the command with a tee at its exact edge.
	const connectorIndex = staged ? rows.findIndex(row => row.live && row.kind === "bar") : -1;
	const renderConnector = (row: Extract<BlockRow, { kind: "bar" }>): string => {
		if (topWidth === splitWidth) return renderBar(row, topWidth);
		const rightWidth = splitWidth - topWidth;
		return (
			renderBar(
				{ leftChar: row.leftChar, rightChar: theme.boxRound.teeUp, label: labelOnRight ? undefined : row.label },
				topWidth,
				topWidth >= visibleWidth(cap) + 2 ? cap : "",
			) +
			renderBar(
				{
					leftChar: "",
					rightChar: theme.boxRound.topRight,
					label: labelOnRight ? row.label : undefined,
					action: row.action,
				},
				rightWidth,
				rightWidth > 1 ? h : "",
			)
		);
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
		const widthHere = rowWidth(row.live);
		const line =
			r === connectorIndex && row.kind === "bar"
				? renderConnector(row)
				: row.kind === "bar" || row.kind === "bottom"
					? renderBar(row, widthHere)
					: renderContent(row.inner);
		const clip = staged
			? widthHere < Math.max(visibleWidth(cap) + 2, contentPaddingLeft + contentPaddingRight + 2)
			: clipFrame;
		lines.push(padToWidth(clip ? truncateToWidth(line, widthHere, Ellipsis.Omit) : line, widthHere, bgFn));
	}

	const firstLiveRow = rows.findIndex(row => row.live);
	return {
		lines,
		topStageRows: options.stageTone === undefined ? 0 : firstLiveRow < 0 ? rows.length : firstLiveRow,
		liveWidth: staged ? splitWidth : 0,
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
		h.optional(options.footerMeta);
		h.optional(options.footerAction);
		h.optional(options.state);
		h.optional(options.stageTone);
		h.u32(options.minLiveWidth ?? 0);
		h.optional(options.borderColor);
		h.bool(options.applyBg ?? true);
		h.bool(options.fitToContent ?? false);
		if (options.sections) {
			for (const s of options.sections) {
				h.optional(s.label);
				h.optional(s.separatorAction);
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
