import { type Component, Container, type HistoryBatch, ownDescription } from "../tui";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { popLoopPhase, pushLoopPhase } from "@oh-my-pi/pi-utils";
import { measureRender, renderForScrollback } from "../components/image";
import { col } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import { sameItems } from "../native/memo";
import { isNativeSettled, settleNative } from "../native/settle";
import { isUsageRowBlock } from "../overlays/usage-row";
import { isToolActivityComponent } from "./tool-activity";
import { directPlacementLift, ImageProtocol, iterm2ImagePayload, TERMINAL } from "../terminal-capabilities";

/** Shared animation time supplied by the constrained transcript root. */
export interface AnimationFrame {
	readonly tick: number;
	readonly now: number;
}

/** Lets an active block adapt its presentation to its allocated viewport rows. */
export interface TranscriptPresentationTarget {
	setTranscriptAllocation?(rows: number, frame: AnimationFrame): void;
	renderTranscriptCompact?(width: number, rows?: number, lines?: readonly string[]): readonly string[];
	/**
	 * Rows of this streaming block no longer fit on screen and none of them is
	 * stable yet: freeze whatever layout keeps its finished rows changing (a
	 * table's column widths) so they can go to scrollback.
	 */
	lockStreamingLayout?(): void;
}

/** Presentation declaration captured permanently when a block is added. */
export type TranscriptBlockMode = "mutable" | "appendOnly";

/** Immutable width-independent identity for one stable semantic row. */
export interface TranscriptStableRow {
	readonly key: string;
}

/**
 * Explicit semantic-row contract for a block whose stable head may enter native
 * history before finalization. Every later array must extend the prior keys
 * exactly; each row renderer is deterministic for its width.
 * A publication that breaks these invariants (e.g. a mid-stream theme change
 * re-coloring already-emitted bytes) freezes further stable-row emission for
 * that block instead of failing the render — see {@link TranscriptContainer}.
 */
export interface AppendOnlyTranscriptBlock {
	readonly transcriptBlockMode: "appendOnly";
	/** Publish a completed semantic prefix even while the viewport has room. */
	readonly commitStableRowsEarly?: boolean;
	getTranscriptStableRows(): readonly TranscriptStableRow[];
	/**
	 * Render the first `count` semantic rows at the requested current width.
	 * Counts are monotonic identities, not physical row counts; this output must
	 * prefix the block's full render at the same width.
	 */
	renderTranscriptStableRows(count: number, width: number): readonly string[];
	/**
	 * Discard every published stable row so the block re-renders its head from
	 * scratch. Called only alongside a destructive display reset (e.g. a
	 * thinking-visibility toggle) that clears the native scrollback those rows
	 * occupied — the sole context in which the append-only "published bytes never
	 * change" contract may be retracted. Optional: blocks whose stable-row
	 * presentation never changes may omit it.
	 */
	resetTranscriptStableRows?(): void;
}

interface FinalizableBlock {
	isTranscriptBlockFinalized?(native?: boolean): boolean;
	readonly commitToHistoryOnFinalize?: boolean;
	/** Immutable prefix in trimmed render rows, excluding mutable status/output. */
	getTranscriptReadyRowCount?(width: number): number;
	/**
	 * A finalized block whose rows still wait on async work (an SVG figure's
	 * raster). Retirement holds until it lands: committed rows can never be
	 * repainted, so retiring early would freeze a placeholder into scrollback.
	 */
	isTranscriptBlockPending?(): boolean;
	/** Render the row that must remain represented under emergency viewport pressure. */
	renderTranscriptBlockEmergencyRow?(width: number): string | undefined;
}

/**
 * Lets a block pack against its neighbors. Two consecutive compact blocks
 * (blocks that draw nothing between them don't count) have no blank separator
 * row between them in the terminal, and a native (TSP) surface groups each
 * such run into one gapless entry. The hook is read every frame, so a block
 * may change its answer at any time (expanded, collapsed, re-presented).
 */
export interface CompactTranscriptBlock {
	/** Whether the block's current presentation is compact rows. */
	isTranscriptBlockCompact?(): boolean;
	/**
	 * Flush group of a non-compact block: two consecutive blocks naming the
	 * same group (file-change cards from separate calls) stack with no blank
	 * row between them, and a native surface groups them into one gapless
	 * entry, like one call's cards. Read every frame.
	 */
	transcriptJoinKey?(): string | undefined;
	/** How many items (files) this joinable block counts toward its run's total; 1 when absent. */
	transcriptJoinCount?(): number;
	/**
	 * Set every frame on a live joinable block: the run's total when it is the
	 * run's last block and the run counts at least two items, which it then
	 * draws under itself (`• Edit (3)`); `undefined` otherwise.
	 */
	setTranscriptJoinRun?(total: number | undefined): void;
	/** The total last set by {@link setTranscriptJoinRun}, so a committed run end stays closed. */
	transcriptJoinRun?(): number | undefined;
}

/**
 * Block lifecycle:
 * - `active`: still mutating; renders live and counts against tool admission.
 * - `settled`: finalized, awaiting explicit readiness or viewport pressure.
 * - `committed`: logically retired; replay never rewinds this state.
 */
type BlockState = "active" | "settled" | "committed";

interface TranscriptEntry {
	component: Component;
	state: BlockState;
	mode: TranscriptBlockMode;
	stableRows: readonly TranscriptStableRow[];
	renderedStableByWidth: Map<number, readonly string[]>;
	/**
	 * Rendered row counts per `(width, snapshot count)`: lets the projected
	 * length skip the re-render when the same prefix was already rendered.
	 * Keyed on both dimensions because one snapshot commonly renders to
	 * multiple physical rows (Markdown wrap).
	 */
	stableRowCountByWidth: Map<number, Map<number, number>>;
	emitted: number;
	/**
	 * Set when a published stable row drifted (retraction, byte change within a
	 * width epoch, or no longer a render prefix). Rows already in native
	 * scrollback cannot be retracted, so the entry keeps its last good stable
	 * state for emitted-row slicing but never emits another mid-stream row.
	 */
	stableFrozen: boolean;
	/** Proves each frame that the published stable rows still prefix the block's render. */
	stableRenderPrefix: RowPrefixCheck;
	/**
	 * Immutable head rows already published while the rest stays live.
	 * Used for pressure-split settled blocks and ready command stages of
	 * running tools; published rows never rejoin the mutable viewport.
	 */
	split: RowSplit | undefined;
}

/**
 * A committed physical row prefix of one block. `rows` counts trimmed render
 * rows at `width` (any emitted stable prefix included) and `hash` fingerprints
 * them; `text` is their letters and digits in order. A settled block can still
 * change (a tool pane expanding) or rewrap at another width without a replay,
 * so every render re-locates the seam: the committed rows when they render
 * unchanged, else by continuing `text` — per-row decoration (quote bars,
 * borders, rules) is punctuation it ignores.
 */
interface RowSplit {
	readonly rows: number;
	readonly width: number;
	readonly hash: number | bigint;
	readonly text: string;
	/**
	 * Inline images in the committed rows, in order, each with its payload and
	 * the length of `text` before it. Their reserved rows carry no content, so
	 * relocating by `text` alone would stop above an image and make the
	 * archived image live again at another width; payload and offset tell the
	 * archived image apart from a replacement or one moved elsewhere.
	 */
	readonly images: readonly { readonly payload: string; readonly offset: number }[];
	/** Seam of the last render it was located in; renders are memoized per frame. */
	located?: { readonly rendered: readonly string[]; readonly count: number };
}

type RetirementPolicy = "pressure" | "flush";
type Offered =
	/** `lead`: the rows start with the blank history owed the head (see {@link RowsAbove}). */
	| { batch: HistoryBatch; kind: "append"; entry: number; emittedEnd: number; lead: boolean }
	/**
	 * Whole blocks `[frontier, end)`, then optionally the head rows of block
	 * `end`: a settled block's `split`, or a streaming block's stable rows up to
	 * `headEmittedEnd`; `historyEnd` is what history ends with once it is
	 * acknowledged.
	 */
	| {
			batch: HistoryBatch;
			kind: "commit";
			end: number;
			split?: RowSplit;
			headEmittedEnd?: number;
			historyEnd: RowsAbove;
	  }
	| { batch: HistoryBatch; kind: "replay"; historyEnd: RowsAbove };

/**
 * Join key ({@link joinKey}) of the last non-empty block above when its
 * separator is still owed; `undefined` when none is (nothing above, or rows
 * ending in a blank).
 */
type RowsAbove = JoinKey | undefined;

/** What a block packs with: blocks with the same non-null key share no separator row. */
type JoinKey = string | null;

const COMPACT_JOIN = "\0compact";
/** Key of a run's last block once it drew the run's total: nothing joins below it. */
const CLOSED_JOIN = "\0closed";

/** Rows a progressive-append retirement offers, and the stable count they bring the head to. */
interface AppendBatch {
	rows: readonly string[];
	emittedEnd: number;
}

const MAX_LIVE_BLOCKS = 256;
/** Grace before a pressure-blocked frontier is reported; a streaming block may legitimately hold it briefly. */
const PINNED_FRONTIER_WARN_MS = 30_000;
/**
 * Rows a running tool keeps when a taller block follows it. A running Bash needs five to keep
 * its frame, its command, the `Output · Running` state row and its footer; four drops the state
 * row, which is what tells a running tool from a finished one.
 */
const ACTIVE_BLOCK_ROWS = 5;
/** Minimum gap between degraded-viewport log lines, so a flapping layout cannot flood the log. */
const DEGRADED_VIEWPORT_LOG_INTERVAL_MS = 60_000;
/**
 * Wall-clock budget for composing one retirement batch. A resumed session
 * hands the container its whole ledger at once, and rendering all of it in the
 * frame that first paints it blocks the loop for as long as that render takes
 * (#12933). Retirement stops after the first block that crosses the budget;
 * the remainder follows on the next frames, which the TUI schedules through
 * timers, so terminal input runs between batches.
 */
const RETIREMENT_BUDGET_MS = 8;
const EMPTY_ROWS: readonly string[] = [];
const EMPTY_STABLE_ROWS: readonly TranscriptStableRow[] = [];

/** A block's full-allocation render taken by {@link TranscriptContainer}'s walk-order measurement. */
interface MeasuredBlock {
	rows: readonly string[];
	/** Whether the render observed a budgeted image; see {@link measureRender}. */
	images: boolean;
}

function isFinalized(component: Component, native = false): boolean {
	const block = component as Component & FinalizableBlock;
	return (block.isTranscriptBlockFinalized?.(native) ?? true) && block.isTranscriptBlockPending?.() !== true;
}

function isCompact(component: Component): boolean {
	return (component as Component & CompactTranscriptBlock).isTranscriptBlockCompact?.() === true;
}

function joinKey(component: Component): JoinKey {
	if (isCompact(component)) return COMPACT_JOIN;
	return (component as Component & CompactTranscriptBlock).transcriptJoinKey?.() ?? null;
}

/** The key a block joins the block below it with: closed once it drew its run's total. */
function tailKey(component: Component): JoinKey {
	return (component as Component & CompactTranscriptBlock).transcriptJoinRun?.() === undefined
		? joinKey(component)
		: CLOSED_JOIN;
}

/** Blank rows before a non-empty block: one, unless none is owed or both blocks share a join key. */
function separatorRows(above: RowsAbove, join: JoinKey): number {
	return above === undefined || (above !== null && above === join) ? 0 : 1;
}

/** Whether a native surface lays out nothing of `component` (a hidden node, or a `col`/`row` of such nodes). */
function describesNothing(component: Component, cx: DescribeContext, depth = 0): boolean {
	// `null`: the reconciler draws it as rows.
	const described = ownDescription(component, cx);
	return described !== null && isVoidNode(described, cx, depth);
}

function isVoidNode(described: NativeNode, cx: DescribeContext, depth: number): boolean {
	if ((described.p as { hidden?: boolean } | undefined)?.hidden === true) return true;
	if ((described.k !== "col" && described.k !== "row") || depth > 16) return false;
	for (const child of described.c ?? []) {
		if ("k" in child ? !isVoidNode(child, cx, depth + 1) : !describesNothing(child, cx, depth + 1)) return false;
	}
	return true;
}

function blockMode(component: Component): TranscriptBlockMode {
	return (component as Component & Partial<AppendOnlyTranscriptBlock>).transcriptBlockMode === "appendOnly"
		? "appendOnly"
		: "mutable";
}

function isPlainBlank(line: string): boolean {
	return !/\S/.test(line);
}

/** Letters and digits of `rows` in reading order: the content rewrapping preserves. */
function contentOf(rows: readonly string[]): string {
	let text = "";
	for (const row of rows) text += Bun.stripANSI(row).replace(/[^\p{L}\p{N}]/gu, "");
	return text;
}

/**
 * Split committing the first `rows` rows of `scrollback` at `width`. The
 * fingerprint covers the scrollback bytes history receives, which can differ
 * from the measured render at the same row count (a SIXEL image encodes
 * synchronously instead of returning its reserved rows).
 */
function rowSplit(scrollback: readonly string[], rows: number, width: number): RowSplit {
	const committed = scrollback.slice(0, rows);
	const images: { payload: string; offset: number }[] = [];
	let text = "";
	for (const row of committed) {
		if (TERMINAL.isImageLine(row)) images.push({ payload: iterm2ImagePayload(row) ?? row, offset: text.length });
		text += contentOf([row]);
	}
	return { rows, width, hash: Bun.hash(committed.join("\n")), text, images };
}

/**
 * `cut` moved to just below an image it would split, on terminals that cannot
 * draw part of an image (iTerm2's inline images). There the image row draws
 * the whole picture upward over its reserved rows; once some of those rows are
 * in scrollback, the picture has nowhere to go and is dropped, so the image
 * must reach scrollback whole. Kitty and SIXEL draw the visible part instead.
 */
function cutBelowWholeImage(rows: readonly string[], cut: number): number {
	const protocol = TERMINAL.imageProtocol;
	if (protocol === null || protocol === ImageProtocol.Kitty || protocol === ImageProtocol.Sixel) return cut;
	// Only reserved rows sit between a cut inside an image and its image row,
	// so the first image row at or below the cut decides.
	for (let index = Math.max(0, cut); index < rows.length; index++) {
		const row = rows[index]!;
		if (!TERMINAL.isImageLine(row)) continue;
		return index - directPlacementLift(row) < cut ? index + 1 : cut;
	}
	return cut;
}

/** Whether `prefix` matches `rows` byte-for-byte from the top. */
export function isRowPrefix(prefix: readonly string[], rows: readonly string[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index] !== rows[index]) return false;
	}
	return true;
}

/**
 * {@link isRowPrefix} for a check repeated every frame on rows that mostly
 * carry over. Stable rows and a block's render are separate renders, so their
 * equal rows are distinct strings that compare byte by byte; this keeps copies
 * of the last pair it proved and re-proves a row that is still the same string
 * on both sides by transitivity, which compares pointers. The copies, not the
 * caller's arrays, are the proof, so a renderer that reuses and rewrites a
 * returned array is still caught.
 */
export class RowPrefixCheck {
	#prefix: readonly string[] = EMPTY_ROWS;
	#rows: readonly string[] = EMPTY_ROWS;

	/** Whether `prefix` matches `rows` byte-for-byte from the top. */
	holds(prefix: readonly string[], rows: readonly string[]): boolean {
		if (prefix.length > rows.length) return false;
		const proven = this.#prefix;
		const provenRows = this.#rows;
		const carried = Math.min(proven.length, prefix.length);
		let index = 0;
		while (index < carried && prefix[index] === proven[index] && rows[index] === provenRows[index]) index++;
		for (; index < prefix.length; index++) {
			if (prefix[index] !== rows[index]) return false;
		}
		this.#prefix = prefix.slice();
		this.#rows = rows.slice(0, prefix.length);
		return true;
	}
}

function isStablePrefix(prefix: readonly TranscriptStableRow[], rows: readonly TranscriptStableRow[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index]!.key !== rows[index]!.key) return false;
	}
	return true;
}

/** Strip leading/trailing all-blank rows; the viewport allocator measures blocks by this trimmed height. */
export function trimBlankEdges(rows: readonly string[]): readonly string[] {
	let start = 0;
	let end = rows.length;
	while (start < end && isPlainBlank(rows[start]!)) start++;
	while (end > start && isPlainBlank(rows[end - 1]!)) end--;
	return start === 0 && end === rows.length ? rows : rows.slice(start, end);
}

/** One live block's row span in the last `renderViewport` output (half-open `[start, end)`). */
export interface TranscriptViewportSpan {
	component: Component;
	start: number;
	end: number;
}

/**
 * One native entry for a run of consecutive transcript blocks that share a
 * join key (compact blocks, or flush-stacking cards such as file changes): a
 * gapless column whose members stay component children, so each describes
 * itself, keeps its wire id and receives its own native events.
 */
class CompactRun implements Component {
	#members: readonly Component[] = [];
	#role = "omp.compact";
	#node: NativeNode | undefined;

	/** Adopt `children[start, end)` as the members; the description holds while they and the role are unchanged. */
	setMembers(children: readonly Component[], start: number, end: number, role: string): void {
		const members = this.#members;
		let same = members.length === end - start && this.#role === role;
		for (let index = 0; same && index < members.length; index++) same = members[index] === children[start + index];
		if (same) return;
		this.#members = children.slice(start, end);
		this.#role = role;
		this.#node = undefined;
	}

	/** Rows for a surface that cannot describe the run: the members' rows, packed. */
	render(width: number): readonly string[] {
		return this.#members.flatMap(member => member.render(width));
	}

	describe(): NativeNode {
		this.#node ??= col(this.#members, { role: this.#role, gap: "none" });
		return this.#node;
	}
}

/** {@link TranscriptContainer.nativeBlocks}' run wrappers while no run has formed. */
const NO_RUNS: ReadonlyMap<Component, CompactRun> = new Map();

/** Owns transcript order, live capacity, and ordered immutable retirement. */
export class TranscriptContainer extends Container {
	#entries: TranscriptEntry[] = [];
	#lastWidth: number | undefined;
	#rebuildLedger: { width: number; rows: readonly string[] } | undefined;
	#frontier = 0;
	#nextBatchId = 1;
	#offered: Offered | undefined;
	#replayPending = false;
	#replayRequested = false;
	#allowEmptyReplay = false;
	#toolActivityVisible = true;
	#lastFrame: AnimationFrame = { tick: 0, now: 0 };
	// Start rows from the last full render(), keyed by child component (transcript deep-links).
	#childStartRows = new Map<Component, number>();
	// Last full render() while no block is committed (transcript viewers), reused while
	// every block returns the same rows: a viewer repaints on every key and tick.
	#fullRender:
		| {
				width: number;
				components: Component[];
				blocks: (readonly string[])[];
				joins: JoinKey[];
				tails: JoinKey[];
				rows: readonly string[];
		  }
		| undefined;
	// Watchdog for the wedge where an unfinalized frontier block pins pressure
	// retirement: everything behind it stays live and degrades to one-line
	// allocations. Logs once per pinned episode after a grace period.
	#pinnedFrontier: { index: number; since: number; logged: boolean } | undefined;
	// Forensic trail for the degraded one-row-per-block layout: logged when the situation
	// changes, never per frame, and at most once a minute.
	#degradedViewport: { signature: string; at: number } | undefined;
	/** Block spans of the last `renderViewport` output, for click hit-testing. */
	#lastViewportSpans: TranscriptViewportSpan[] = [];
	/**
	 * The composed frame {@link beginFrame} opened; `undefined` outside one.
	 * {@link renderViewport} closes it, so it never outlives the synchronous
	 * composition that opened it.
	 */
	#openFrame: AnimationFrame | undefined;
	/**
	 * Full-allocation blank-trimmed renders of the blocks measured during the
	 * open frame, keyed by entry at {@link #frameRowsWidth}. A retirement peek
	 * and the viewport measure the same live blocks back to back inside one
	 * composition, with no block mutation possible in between; replaying the
	 * first measurement spares every block its second render per frame.
	 */
	#frameRows = new Map<TranscriptEntry, MeasuredBlock>();
	#frameRowsWidth = 0;
	#releaseFailures = new WeakSet<Component>();
	/** The `children` array `#entries` last mirrored; see {@link #syncEntries}. */
	#syncedChildren: Component[] | undefined;
	/** Forces the next {@link #syncEntries} to compare every entry, not just the live tail. */
	#entriesUnverified = false;
	/** Block list handed to the native frame provider, reused while the children are unchanged. */
	#nativeBlocks: readonly Component[] = [];
	#nativeNode: NativeNode | undefined;
	/** Join key of history's last block while its separator is withheld (see {@link RowsAbove}); history rows never change. */
	#historyEnd: RowsAbove;
	/** Native wrappers of compact runs keyed by their first member; see {@link nativeBlocks}. */
	#nativeRuns: ReadonlyMap<Component, CompactRun> = NO_RUNS;
	/**
	 * The live tail's `{ entry, index }` wrappers, reused while `#entries` holds the
	 * same entries from the same start: the per-frame readers (`liveRowCount`,
	 * `#composeViewport`, `#peekBatch`) would otherwise each allocate one per live block.
	 */
	#liveWrappers: ReadonlyArray<{ entry: TranscriptEntry; index: number }> = [];
	#liveWrappersStart = 0;
	override addChild(component: Component): void {
		if (isToolActivityComponent(component)) component.setToolActivityVisible(this.#toolActivityVisible);
		super.addChild(component);
		this.#entries.push({
			component,
			state: "active",
			mode: blockMode(component),
			stableRows: EMPTY_STABLE_ROWS,
			renderedStableByWidth: new Map(),
			stableRowCountByWidth: new Map(),
			emitted: 0,
			stableFrozen: false,
			stableRenderPrefix: new RowPrefixCheck(),
			split: undefined,
		});
		// `children` is public and may be edited externally; re-check the whole
		// list once instead of trusting positions. Insert-after-anchor callers
		// use insertChildAt, which keeps both arrays in lockstep.
		this.#entriesUnverified = true;
	}

	/**
	 * `#entries` mirrors `children`; move both together or the next `#syncEntries`
	 * pays a full O(n) rebuild.
	 */
	insertChildAt(component: Component, index: number): void {
		this.addChild(component);
		const from = this.children.length - 1;
		if (index >= from) {
			this.#entriesUnverified = false;
			return;
		}
		const [moved] = this.children.splice(from, 1);
		if (moved) this.children.splice(index, 0, moved);
		const [entry] = this.#entries.splice(this.#entries.length - 1, 1);
		if (entry) this.#entries.splice(index, 0, entry);
		// Both arrays moved in lockstep, so the live-tail check applies again.
		this.#entriesUnverified = false;
	}

	/** Removes `component` if {@link canRemoveBlock} allows it; otherwise does nothing. */
	override removeChild(component: Component): void {
		const index = this.#removableIndex(component);
		if (index < 0) return;
		// #removableIndex synced entries, which now mirror children index for
		// index. This class renders through its own entries, never Container's
		// memoized render, so splicing children directly is the whole removal.
		this.children.splice(index, 1);
		this.#entries.splice(index, 1);
		this.#frontier = Math.min(this.#frontier, this.#entries.length);
		this.#childStartRows.delete(component);
		this.#fullRender = undefined;
	}

	override clear(): void {
		this.#syncEntries();
		const width = this.#lastWidth;
		const preserved =
			width !== undefined && this.#entries.length > 0 && this.#offered?.kind !== "replay"
				? { width, rows: this.#renderReplay(width).rows }
				: this.#rebuildLedger;
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
		this.#childStartRows.clear();
		this.#fullRender = undefined;
		this.#pinnedFrontier = undefined;
		this.#replayPending = false;
		this.#replayRequested = false;
		this.#allowEmptyReplay = false;
		this.#lastViewportSpans = [];
		this.#closeFrame();
		this.#rebuildLedger = preserved?.rows.length ? preserved : undefined;
		this.#historyEnd = undefined;
	}

	setToolActivityVisible(visible: boolean): void {
		if (this.#toolActivityVisible === visible) return;
		this.#toolActivityVisible = visible;
		for (const child of this.children) {
			if (isToolActivityComponent(child)) child.setToolActivityVisible(visible);
		}
		this.invalidate();
	}

	/**
	 * Forget the append-only emission ledger — emitted counts, published stable
	 * rows, per-width render cache, and freeze state — for every block, and ask
	 * each append-only block to drop its own published rows. The next replay then
	 * re-renders each block from its current {@link Component.render}, applying a
	 * changed presentation (e.g. a thinking-visibility toggle) to rows that were
	 * already emitted as stable heads while streaming (#10177).
	 *
	 * Callers MUST pair this with a scrollback-clearing {@link resetDisplay}: the
	 * emitted rows it forgets still sit in native history until that clear
	 * rewrites them, so unpaired use would duplicate them on the next retirement.
	 */
	resetStableEmission(): void {
		this.#rebuildLedger = undefined;
		this.#syncEntries();
		const offered = this.#offered;
		if (
			offered?.kind === "append" ||
			(offered?.kind === "commit" && (offered.split || offered.headEmittedEnd !== undefined))
		) {
			this.#offered = undefined;
		}
		this.#historyEnd = undefined;
		for (const entry of this.#entries) {
			entry.emitted = 0;
			entry.stableRows = EMPTY_STABLE_ROWS;
			entry.renderedStableByWidth = new Map();
			entry.stableRowCountByWidth = new Map();
			entry.stableFrozen = false;
			entry.split = undefined;
			if (entry.mode === "appendOnly") {
				(entry.component as Component & AppendOnlyTranscriptBlock).resetTranscriptStableRows?.();
			}
		}
	}

	/** Whether a transient block may be discarded without leaving tape history. */
	canRemoveBlock(component: Component): boolean {
		return this.#removableIndex(component) >= 0;
	}

	/**
	 * Syncs entries, then returns `component`'s index if it can be discarded
	 * without leaving tape history (not committed, not emitted, not in an
	 * offered batch), else -1.
	 */
	#removableIndex(component: Component): number {
		this.#syncEntries();
		// Removable blocks are transient ones near the live tail, so search from there.
		const index = this.#entries.findLastIndex(entry => entry.component === component);
		if (index < 0) return -1;
		const entry = this.#entries[index]!;
		if (entry.state === "committed" || entry.emitted > 0 || entry.split !== undefined) return -1;
		// A commit protects its boundary block too when it carries rows of it:
		// a split's head, or a streaming block's stable rows (completeScrollback).
		const offered = this.#offered;
		const carriesBoundary = offered?.kind === "commit" && (offered.split || offered.headEmittedEnd !== undefined);
		if (offered?.kind === "commit" && index < offered.end + (carriesBoundary ? 1 : 0)) return -1;
		if (offered?.kind === "append" && index === offered.entry) return -1;
		return index;
	}

	/**
	 * Whether a superseded snapshot block (a repeated `wait` poll) may be
	 * replaced by its successor. Beyond {@link canRemoveBlock}, a block directly
	 * above a usage row stays: that row describes the turn the block belongs to,
	 * and removing the block would leave a usage-only turn (#12248).
	 */
	canDisplaceBlock(component: Component): boolean {
		if (!this.canRemoveBlock(component)) return false;
		const next = this.children[this.children.indexOf(component) + 1];
		return next === undefined || !isUsageRowBlock(next);
	}

	/** Insert asynchronous notices before the active tail without reordering retired blocks. */
	insertSettledBlock(component: Component): void {
		const index = this.children.findIndex(child => !isFinalized(child));
		this.insertChildAt(component, index < 0 ? this.children.length : index);
	}

	/** Unpublished cards may still be replaced by their live continuations. */
	isBlockUncommitted(component: Component): boolean {
		return !this.children.includes(component) || this.canRemoveBlock(component);
	}

	isBlockInLiveRegion(component: Component): boolean {
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		return index >= this.#frontier && index >= 0;
	}

	/** Lifecycle state per block in transcript order (diagnostics and tests). */
	blockStates(): readonly BlockState[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.state);
	}

	/** Permanently captured presentation mode per block (diagnostics and tests). */
	blockModes(): readonly TranscriptBlockMode[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.mode);
	}

	/** Emitted stable semantic-row counts in transcript order. */
	emittedStableRows(): readonly number[] {
		this.#syncEntries();
		return this.#entries.map(entry => entry.emitted);
	}

	/** Whether any block is still streaming or otherwise unfinalized. */
	hasActiveBlock(): boolean {
		this.#syncEntries();
		this.#settleFinalized();
		for (let index = this.#frontier; index < this.#entries.length; index++) {
			if (this.#entries[index]!.state === "active") return true;
		}
		return false;
	}

	/** Whether visible active capacity and live-block memory permit another admission. */
	canAdmit(rows: number): boolean {
		const active = this.#entries.filter(entry => entry.state === "active").length;
		return Math.max(0, Math.trunc(rows)) > active && this.#liveCount() < MAX_LIVE_BLOCKS;
	}

	/** Prepares one atomic replay of the committed ledger and an emitted active-head prefix. */
	beginReplay(allowEmptyReplay = false): void {
		this.#allowEmptyReplay ||= allowEmptyReplay;
		this.#syncEntries();
		if (this.#offered !== undefined || this.#rebuildLedger !== undefined) {
			this.#replayRequested = true;
			return;
		}
		this.#startReplay();
	}
	/**
	 * Drop a not-yet-offered replay so a shutdown flush emits only un-retired
	 * rows. The terminal already holds the committed ledger; re-streaming it at
	 * quit is pure write volume. An already offered replay batch stays valid.
	 */
	cancelReplay(): void {
		this.#replayPending = false;
		this.#replayRequested = false;
		this.#allowEmptyReplay = false;
	}

	/**
	 * Open one composed frame: every live-block measurement until this frame's
	 * {@link renderViewport} returns renders against `frame` and is taken once,
	 * so the retirement peek and the viewport share each block's render.
	 *
	 * Callers MUST call {@link renderViewport} with the same `frame` in the same
	 * synchronous composition, without mutating any transcript block in
	 * between: the shared rows are only as fresh as that first measurement.
	 */
	beginFrame(frame: AnimationFrame): void {
		this.#lastFrame = frame;
		this.#frameRows.clear();
		this.#openFrame = frame;
	}

	/**
	 * Total rows the live, un-emitted tail occupies at `width`.
	 *
	 * `limit` stops the walk once the total passes it: measuring a resumed
	 * session's whole ledger costs one full render per block, and callers only
	 * compare the height against a viewport budget. Past `limit` the result is
	 * a lower bound, guaranteed only to be greater than `limit`.
	 */
	liveRowCount(width: number, limit = Number.POSITIVE_INFINITY): number {
		this.#enterFrame(width);
		let total = 0;
		let above = this.#projectedHistoryEnd();
		for (const { entry, index } of this.#liveEntries()) {
			const block = this.#liveBlock(entry, index, width).rows;
			if (block.length === 0) continue;
			const join = joinKey(entry.component);
			total += separatorRows(above, join) + block.length;
			above = tailKey(entry.component);
			if (total > limit) break;
		}
		return total;
	}

	/** One live block's un-emitted rows at `width`, measured against its full-height allocation. */
	#liveBlock(entry: TranscriptEntry, index: number, width: number): MeasuredBlock {
		const measured = this.#measure(entry, width);
		const emitted = this.#projectedEmittedRowCount(entry, index, width);
		return emitted === 0 ? measured : { rows: measured.rows.slice(emitted), images: measured.images };
	}

	/** What native history ends with once the unacknowledged offer, if any, lands. */
	#projectedHistoryEnd(): RowsAbove {
		const offered = this.#offered;
		if (offered === undefined) return this.#historyEnd;
		return offered.kind === "append" ? undefined : offered.historyEnd;
	}

	/** Index into `live` of the first non-empty block when history owes it a separator, else -1. */
	#owedLead(live: readonly { entry: TranscriptEntry; index: number }[], width: number): number {
		const historyEnd = this.#projectedHistoryEnd();
		if (historyEnd === undefined) return -1;
		for (let cursor = 0; cursor < live.length; cursor++) {
			const { entry, index } = live[cursor]!;
			if (this.#liveBlock(entry, index, width).rows.length === 0) continue;
			return separatorRows(historyEnd, joinKey(entry.component)) > 0 ? cursor : -1;
		}
		return -1;
	}

	/**
	 * One block's blank-trimmed render at its full-height allocation. Inside an
	 * open frame the first measurement of each block is replayed to later ones,
	 * leaving whatever allocation the viewport has since rendered it at.
	 *
	 * Measurements run in walk order, not display order, so they render under
	 * {@link measureRender}: a block whose images they observed must render
	 * again in display order before its rows are laid out.
	 */
	#measure(entry: TranscriptEntry, width: number): MeasuredBlock {
		if (this.#openFrame === undefined) return this.#measureEntry(entry, width);
		if (this.#frameRowsWidth !== width) {
			this.#frameRows.clear();
			this.#frameRowsWidth = width;
		}
		let measured = this.#frameRows.get(entry);
		if (measured === undefined) {
			measured = this.#measureEntry(entry, width);
			this.#frameRows.set(entry, measured);
		}
		return measured;
	}

	#measureEntry(entry: TranscriptEntry, width: number): MeasuredBlock {
		this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
		const { value: rows, images } = measureRender(() => this.#renderEntry(entry, width));
		return { rows, images };
	}

	#closeFrame(): void {
		this.#openFrame = undefined;
		this.#frameRows.clear();
	}

	/** Block spans of the last `renderViewport` output, in output coordinates. Empty when the tail is empty. */
	getLastViewportSpans(): readonly TranscriptViewportSpan[] {
		return this.#lastViewportSpans;
	}

	/** Collapse a per-line owner list into run-length block spans, clamped to `length`. */
	#commitViewportSpans(owners: readonly (Component | undefined)[], length: number = owners.length): void {
		const spans: TranscriptViewportSpan[] = [];
		let index = 0;
		while (index < length) {
			const component = owners[index];
			if (component === undefined) {
				index++;
				continue;
			}
			let end = index + 1;
			while (end < length && owners[end] === component) end++;
			spans.push({ component, start: index, end });
			index = end;
		}
		this.#lastViewportSpans = spans;
	}

	/**
	 * Render the live tail, constrained to the supplied transcript height.
	 * Closes the frame {@link beginFrame} opened; a different `frame` discards
	 * its measurements first.
	 */
	renderViewport(width: number, rows: number, frame: AnimationFrame): readonly string[] {
		if (frame !== this.#openFrame) this.#closeFrame();
		this.#lastFrame = frame;
		try {
			return this.#composeViewport(width, rows, frame);
		} finally {
			this.#closeFrame();
		}
	}

	#composeViewport(width: number, rows: number, frame: AnimationFrame): readonly string[] {
		this.#enterFrame(width);
		const live = this.#liveEntries();
		const capacity = Math.max(0, Math.trunc(rows));
		if (live.length === 0 || capacity === 0) {
			this.#lastViewportSpans = [];
			return EMPTY_ROWS;
		}
		// Settled history before the oldest running block need not compete for
		// live space. Keep the whole active suffix visible when it fits, then
		// fill the remaining viewport with the natural tail of settled history.
		const firstUnsettled = live.findIndex(({ entry }) => entry.state !== "settled");
		let naturalTail = firstUnsettled < 0;

		// Collect newest-first and stop one block past the viewport's row budget.
		// Older settled blocks cannot affect its natural tail; measuring the
		// whole ledger would stall a resumed session's first paint (#12933).
		const shown: Array<{ entry: TranscriptEntry; index: number }> = [];
		const blocks: (readonly string[])[] = [];
		const measuredImages: boolean[] = [];
		let unrendered = 0;
		let naturalRows = 0;
		// Join key of the nearest shown block below the cursor (blocks with one key share no separator).
		let below: RowsAbove;
		let clipDecided = false;
		let clip = false;
		for (let cursor = live.length - 1; cursor >= 0; cursor--) {
			if (naturalRows >= capacity && (firstUnsettled < 0 || cursor < firstUnsettled)) break;
			if (shown.length > capacity) {
				unrendered = cursor + 1;
				break;
			}
			const candidate = live[cursor]!;
			const block = this.#liveBlock(candidate.entry, candidate.index, width);
			if (block.rows.length === 0) continue;
			shown.push(candidate);
			blocks.push(block.rows);
			measuredImages.push(block.images);
			const join = joinKey(candidate.entry.component);
			naturalRows +=
				block.rows.length + (below === undefined ? 0 : separatorRows(tailKey(candidate.entry.component), below));
			below = join;
			if (cursor === firstUnsettled && naturalRows <= capacity) naturalTail = true;
			// Paint the final natural tail immediately while a finalized backlog
			// drains into scrollback over several budgeted frames.
			if (!clipDecided && naturalRows >= capacity) {
				clipDecided = true;
				clip = this.#retiresThrough(live, cursor, naturalRows > capacity);
				if (clip) break;
			}
		}
		shown.reverse();
		blocks.reverse();
		measuredImages.reverse();
		// The bounded tail walk may stop before a still-running tool. Carry
		// its live suffix separately; do not render the settled backlog.
		for (let cursor = unrendered - 1; cursor >= 0; cursor--) {
			const candidate = live[cursor]!;
			if (candidate.entry.state !== "active" || !isToolActivityComponent(candidate.entry.component)) continue;
			const block = this.#liveBlock(candidate.entry, candidate.index, width);
			if (block.rows.length === 0) continue;
			shown.unshift(candidate);
			blocks.unshift(block.rows);
			measuredImages.unshift(block.images);
			break;
		}
		if (shown.length === 0) {
			this.#lastViewportSpans = [];
			return EMPTY_ROWS;
		}
		// Finished blocks retain their natural rows. Even under extreme pressure,
		// show real tail rows rather than replacing them with a synthetic summary.
		if (!naturalTail && !clip && shown.length > capacity) {
			this.#noteDegradedViewport(live, shown.length, capacity, firstUnsettled);
		}
		// The walk ran newest-first, so the images it measured claimed no
		// display slot (see #measure). Render those blocks again oldest-first:
		// the image budget keeps the newest images live by observation order.
		for (let blockIndex = 0; blockIndex < shown.length; blockIndex++) {
			if (!measuredImages[blockIndex]) continue;
			const { entry, index } = shown[blockIndex]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, frame);
			blocks[blockIndex] = this.#renderEntry(entry, width).slice(
				this.#projectedEmittedRowCount(entry, index, width),
			);
		}
		// Separator rows above each block; the first one's is owed by history.
		const gaps: number[] = [];
		let rowsAbove = this.#projectedHistoryEnd();
		for (let blockIndex = 0; blockIndex < shown.length; blockIndex++) {
			const join = joinKey(shown[blockIndex]!.entry.component);
			gaps.push(separatorRows(rowsAbove, join));
			rowsAbove = tailKey(shown[blockIndex]!.entry.component);
		}
		// A tool that is still running stays visible even when a taller block follows it: it keeps
		// a small readable share (frame, summary, newest rows) instead of scrolling off. Finished
		// blocks are never squeezed; they keep every row and scroll off the top when they do not
		// fit. The newest block takes whatever rows the active ones leave.
		const squeeze = (blockIndex: number, rows: number): void => {
			const { entry, index } = shown[blockIndex]!;
			const emitted = this.#projectedEmittedRowCount(entry, index, width);
			// Published rows no longer consume viewport space, but the renderer's
			// allocation covers the whole card. Budget its live suffix separately.
			this.#setAllocation(entry.component, rows + emitted, frame);
			const rendered = this.#renderEntry(entry, width).slice(emitted);
			const compact =
				rendered.length > rows && isToolActivityComponent(entry.component)
					? (entry.component as Component & TranscriptPresentationTarget).renderTranscriptCompact?.(
							width,
							rows,
							rendered,
						)
					: undefined;
			blocks[blockIndex] = compact ?? (rendered.length <= rows ? rendered : rendered.slice(rendered.length - rows));
		};
		const newest = shown.length - 1;
		// Squeezing only buys room: while everything fits, every block keeps its rows.
		let natural = 0;
		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			if (blocks[blockIndex]!.length > 0) natural += blocks[blockIndex]!.length + gaps[blockIndex]!;
		}
		const overflowing = natural > capacity;
		let firstRunning = -1;
		for (let blockIndex = 0; blockIndex < newest; blockIndex++) {
			const neighbour = shown[blockIndex]!.entry;
			if (neighbour.state !== "active" || !isToolActivityComponent(neighbour.component)) continue;
			// A card waiting only for its result keeps its height and scrolls like a finished one.
			if (neighbour.component.keepsHeightWhileActive?.() === true) continue;
			if (!clip && overflowing && blocks[blockIndex]!.length > ACTIVE_BLOCK_ROWS)
				squeeze(blockIndex, ACTIVE_BLOCK_ROWS);
			if (firstRunning < 0) firstRunning = blockIndex;
		}
		if (!clip && newest >= 0) {
			// Everything from the first running tool up to the newest block stays on screen with it,
			// so the newest block gets what is left after that real height and its separators.
			const stackStart = firstRunning >= 0 ? firstRunning : newest;
			let above = stackStart === 0 ? gaps[0]! : 0;
			if (firstRunning >= 0) {
				for (let blockIndex = firstRunning; blockIndex < newest; blockIndex++) {
					if (blocks[blockIndex]!.length > 0) above += blocks[blockIndex]!.length + gaps[blockIndex + 1]!;
				}
			}
			// Content behind unfinished append-only prose must leave its live tail
			// visible. Its final partial row cannot reach scrollback yet, even when
			// the following tool has finished or other tools are still running.
			if (
				shown.some(
					({ entry }, index) =>
						index < (firstRunning >= 0 ? firstRunning : newest) &&
						entry.state === "active" &&
						entry.mode === "appendOnly" &&
						!isToolActivityComponent(entry.component) &&
						blocks[index]!.length > 0,
				)
			) {
				above += 2;
			}
			const room = Math.max(1, capacity - above);
			if (blocks[newest]!.length > room) squeeze(newest, room);
		}
		const output: string[] = [];
		const owners: (Component | undefined)[] = [];
		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			if (gaps[blockIndex]! > 0) {
				output.push("");
				owners.push(undefined);
			}
			const component = shown[blockIndex]!.entry.component;
			for (const line of blocks[blockIndex]!) {
				output.push(line);
				owners.push(component);
			}
		}
		// A mutable card cannot publish its changing prefix into history. If a
		// tail window intersects that card, ask its renderer for a bounded card
		// instead of exposing raw body rows without their header. Apply this at
		// the final boundary, after pinning and sticky context have taken space.
		const finish = (visibleRows: string[], visibleOwners: (Component | undefined)[]): readonly string[] => {
			for (let start = 0; start < visibleRows.length;) {
				const owner = visibleOwners[start];
				let end = start + 1;
				while (end < visibleRows.length && visibleOwners[end] === owner) end++;
				const index = owner === undefined ? -1 : shown.findIndex(({ entry }) => entry.component === owner);
				if (owner !== undefined && index >= 0 && shown[index]!.entry.state === "active") {
					const source = blocks[index]!;
					const count = end - start;
					if (count < source.length) {
						const bounded = this.#clipViewportBlock(shown[index]!.entry, width, count, source);
						for (let offset = 0; offset < count; offset++) visibleRows[start + offset] = bounded[offset] ?? "";
					}
				}
				start = end;
			}
			this.#commitViewportSpans(visibleOwners, visibleRows.length);
			return visibleRows;
		};
		const drop = Math.max(0, output.length - capacity);
		// Do not let an image clipped through its reserved rows paint over the chrome.
		const headClipped = drop - gaps[0]!;
		if (headClipped > 0) {
			const below = cutBelowWholeImage(blocks[0]!, headClipped);
			if (below > headClipped) output[gaps[0]! + below - 1] = "";
		}
		if (drop > 0 && capacity > ACTIVE_BLOCK_ROWS + 1) {
			for (let index = shown.length - 2; index >= 0; index--) {
				const { entry } = shown[index]!;
				if (entry.state !== "active" || !isToolActivityComponent(entry.component)) continue;
				// Pinning one cuts the newest block's head off; it scrolls off the top instead.
				if (entry.component.keepsHeightWhileActive?.() === true) continue;
				const first = owners.indexOf(entry.component);
				if (first < 0 || first >= drop) continue;
				const pinned = blocks[index]!;
				const room = capacity - pinned.length - 1;
				if (room <= 0) continue;
				const tail = output
					.map((row, index) => ({ row, owner: owners[index] }))
					.filter(({ owner }) => owner !== entry.component)
					.slice(-room);
				const visibleOutput = [...pinned, "", ...tail.map(({ row }) => row)];
				const visibleOwners = [...pinned.map(() => entry.component), undefined, ...tail.map(({ owner }) => owner)];
				return finish(visibleOutput, visibleOwners);
			}
		}
		// Keep a mutable predecessor visible beside its single settled successor
		// by reusing an empty boundary separator, without squeezing finished rows.
		if (drop > 0 && owners[drop] === undefined && output[drop] === "") {
			const index = shown.findIndex(({ entry }) => entry.component === owners[drop - 1]);
			const preceding = shown[index]?.entry;
			if (
				preceding?.state === "active" &&
				preceding.mode !== "appendOnly" &&
				!isToolActivityComponent(preceding.component) &&
				index === shown.length - 2 &&
				shown[index + 1]!.entry.state === "settled"
			) {
				output[drop] = output[drop - 1]!;
				owners[drop] = preceding.component;
			}
		}
		// A prompt or answer that scrolled off the top keeps one row above the tail, so the
		// reader still knows what the agent is working on (#13835). Needs a second row to give.
		if (drop > 0 && capacity > 1) {
			const visible = new Set<Component>();
			for (let row = drop; row < output.length; row++) {
				const owner = owners[row];
				// A block whose visible rows are all blank padding has effectively scrolled off.
				if (owner !== undefined && !isPlainBlank(Bun.stripANSI(output[row]!))) visible.add(owner);
			}
			const lead = this.#scrolledOffRow(live, shown, owners.slice(0, drop), visible, width);
			if (lead !== undefined) {
				const tail = capacity - 1;
				const visibleOutput = [lead.row, ...output.slice(output.length - tail)];
				const visibleOwners = [lead.owner, ...owners.slice(owners.length - tail)];
				return finish(visibleOutput, visibleOwners);
			}
		}
		return finish(drop > 0 ? output.slice(drop) : output, owners.slice(drop));
	}

	/** Preserve an unfinished tool's identity and frame at a viewport boundary; settled history scrolls normally. */
	#clipViewportBlock(
		entry: TranscriptEntry,
		width: number,
		rows: number,
		source: readonly string[],
	): readonly string[] {
		if (rows <= 0) return EMPTY_ROWS;
		if (source.length <= rows) return source;
		if (entry.state === "active" && isToolActivityComponent(entry.component)) {
			const bounded = (entry.component as Component & TranscriptPresentationTarget).renderTranscriptCompact?.(
				width,
				rows,
				source,
			);
			if (bounded !== undefined && bounded.length <= rows) return bounded;
		}
		return source.slice(source.length - rows);
	}

	/**
	 * The newest settled block that lost every visible row and offers a representative row.
	 * That covers blocks cut off the top of the collected window and blocks never collected.
	 */
	#scrolledOffRow(
		live: readonly { entry: TranscriptEntry; index: number }[],
		shown: readonly { entry: TranscriptEntry; index: number }[],
		cutOwners: readonly (Component | undefined)[],
		visible: ReadonlySet<Component>,
		width: number,
	): { row: string; owner: Component } | undefined {
		const firstShown = shown[0]?.index ?? live.length;
		const cut = new Set(cutOwners.filter((owner): owner is Component => owner !== undefined));
		for (let cursor = live.length - 1; cursor >= 0; cursor--) {
			const candidate = live[cursor]!;
			const component = candidate.entry.component;
			if (visible.has(component)) continue;
			if (candidate.index >= firstShown && !cut.has(component)) continue;
			if (candidate.entry.state !== "settled") continue;
			const row = (component as Component & FinalizableBlock).renderTranscriptBlockEmergencyRow?.(width);
			if (row !== undefined) return { row, owner: component };
		}
		return undefined;
	}

	/**
	 * Whether every live block older than `live[cursor]`, and that block itself
	 * (as a split) when `clipped`, is finalized, so pressure retirement takes it
	 * into scrollback once it settles. A finalized block still pending (an async
	 * figure render or image conversion in replayed history) may still swap a
	 * placeholder for its figure, but it is off screen and not yet in scrollback,
	 * so it retires with its final rows; a block still streaming or running
	 * would stay pinned out of view instead.
	 */
	#retiresThrough(live: ReadonlyArray<{ entry: TranscriptEntry }>, cursor: number, clipped: boolean): boolean {
		const end = clipped ? cursor + 1 : cursor;
		for (let index = 0; index < end; index++) {
			const { entry } = live[index]!;
			if (entry.state === "settled") continue;
			const block = entry.component as Component & FinalizableBlock;
			if (block.isTranscriptBlockFinalized?.() === false) return false;
		}
		return true;
	}

	/**
	 * With `completeScrollback`, a streaming block's rows that no longer fit go
	 * to scrollback as soon as they are stable, even when that commits a few
	 * rows still on screen; otherwise those rows are clipped off the top of the
	 * viewport, with no copy in scrollback, until they retire.
	 */
	completeScrollback = false;

	/** Offers explicitly ready parts, or the finalized prefix required by actual capacity. */
	peekFinalizedBatch(width: number, capacity: number): HistoryBatch | undefined {
		return this.#peekBatch(width, capacity, "pressure");
	}

	/** Returns only a prepared complete replay, never a normal retirement offer. */
	peekReplayBatch(width: number): HistoryBatch | undefined {
		this.#enterFrame(width);
		return this.#peekReplayBatch(width);
	}

	#peekReplayBatch(width: number): HistoryBatch | undefined {
		if (this.#offered !== undefined) {
			return this.#offered.kind === "replay" ? this.#offered.batch : undefined;
		}
		if (!this.#replayPending) return undefined;
		// The one path that must compose the whole ledger in a single frame; the
		// phase label attributes any watchdog block here instead of "unknown".
		pushLoopPhase("ui.transcript-replay");
		let replay: { rows: readonly string[]; historyEnd: RowsAbove };
		try {
			replay = this.#renderReplay(width);
		} finally {
			popLoopPhase();
		}
		this.#replayPending = false;
		if (replay.rows.length === 0 && !this.#allowEmptyReplay) {
			// The cleared history holds no transcript rows.
			this.#historyEnd = undefined;
			this.#releaseCommittedRenderCaches();
			return undefined;
		}
		this.#allowEmptyReplay = false;
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows: replay.rows, kind: "replay" };
		this.#offered = { batch, kind: "replay", historyEnd: replay.historyEnd };
		return batch;
	}

	/** Offers the complete currently eligible prefix for graceful shutdown. */
	peekFlushBatch(width: number): HistoryBatch | undefined {
		return this.#peekBatch(width, 0, "flush");
	}

	/** Recompose the unacknowledged batch so a discarded TUI frame can be rendered again. */
	rerenderOfferedBatch(width: number): HistoryBatch | undefined {
		const offered = this.#offered;
		if (offered === undefined) return undefined;
		let rows: readonly string[];
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			if (entry === undefined) return undefined;
			const before = this.#renderStablePrefix(entry, entry.emitted, width);
			const after = this.#renderStablePrefix(entry, offered.emittedEnd, width);
			const added = after.slice(before.length);
			rows = offered.lead ? ["", ...added] : added;
		} else if (offered.kind === "commit") {
			const retirement = this.#renderRange(this.#frontier, offered.end, width, this.#historyEnd);
			rows = retirement.rows;
			const head = offered.split ? this.#entries[offered.end] : undefined;
			if (head !== undefined && offered.split !== undefined) {
				// The offer's fingerprint covers bytes of a discarded frame history
				// never received (an image-budget retry demotes graphics to text),
				// so the split keeps its cut and re-fingerprints the rows it now
				// delivers. Only another width relocates the cut.
				const start = this.#emittedRowCount(head, width);
				const scrollback = renderForScrollback(() => this.#renderEntry(head, width));
				const cut =
					width === offered.split.width ? offered.split.rows : this.#splitRowCount(head, offered.split, width);
				const end = Math.min(cut, scrollback.length);
				offered.split = rowSplit(scrollback, end, width);
				if (separatorRows(retirement.above, joinKey(head.component)) > 0) retirement.rows.push("");
				retirement.rows.push(...scrollback.slice(start, end));
			} else {
				offered.historyEnd = this.#closeRange(retirement.rows, retirement.above, offered.end, width);
			}
			const streaming = offered.headEmittedEnd !== undefined ? this.#entries[offered.end] : undefined;
			if (streaming !== undefined && offered.headEmittedEnd !== undefined) {
				const before = this.#renderStablePrefix(streaming, streaming.emitted, width);
				const after = this.#renderStablePrefix(streaming, offered.headEmittedEnd, width);
				// A head whose stable rows no longer extend its emitted prefix waits
				// for the next offer instead of riding this one. One that rides
				// follows the separator `#closeRange` ended the retired rows with.
				if (isRowPrefix(before, after)) {
					rows = [...rows, ...after.slice(before.length)];
					offered.historyEnd = undefined;
				} else {
					offered.headEmittedEnd = undefined;
				}
			}
		} else {
			const replay = this.#renderReplay(width);
			offered.historyEnd = replay.historyEnd;
			rows = replay.rows;
		}
		offered.batch = { id: offered.batch.id, rows, kind: offered.batch.kind };
		return offered.batch;
	}

	#peekBatch(width: number, capacity: number, policy: RetirementPolicy): HistoryBatch | undefined {
		this.#enterFrame(width);
		if (this.#offered !== undefined) return this.#offered.batch;
		const replay = this.#peekReplayBatch(width);
		if (replay !== undefined) return replay;

		this.#completeFullyEmittedHeads(width);
		const room = Math.max(0, Math.trunc(capacity));
		const live = this.#liveEntries();
		if (live.length === 0) return undefined;
		const ready = this.#offerReadyPrefix(width, room);
		if (ready !== undefined) return ready;

		// Only a render publishes a block's stable rows, so the head renders
		// before its progressive-append eligibility is read.
		const head = this.#entries[this.#frontier];
		if (head !== undefined) this.#measure(head, width);
		const appendHead =
			policy === "pressure" &&
			head?.mode === "appendOnly" &&
			!head.stableFrozen &&
			head.state !== "committed" &&
			head.split === undefined &&
			head.emitted < head.stableRows.length
				? head
				: undefined;
		const eagerAppend =
			appendHead !== undefined &&
			(appendHead.component as Component & AppendOnlyTranscriptBlock).commitStableRowsEarly === true;

		// Measure the live tail newest-first and stop at the first block that
		// does not fit: `keep` counts the leading blocks bound for scrollback,
		// and everything behind them stays unmeasured. Measuring the whole live
		// region costs one full render per block, which on a resumed session's
		// first paint is every message it ever had (#12933). The progressive
		// append path below needs the exact live height to size its emission,
		// and only runs while a streaming head pins retirement. Heights include
		// the separator below each block, and above the first one if history owes it.
		const lead = this.#owedLead(live, width);
		let tailRows = 0;
		let liveRows = 0;
		let keep = 0;
		let fits = true;
		// Join key of the nearest non-empty block below the cursor.
		let below: RowsAbove;
		// Separator rows between the first block that does not fit and the tail.
		let boundaryGap = 0;
		// The first live block fits; only the blank history owes it does not.
		let leadOnly = false;
		for (let cursor = live.length - 1; cursor >= 0; cursor--) {
			const candidate = live[cursor]!;
			const rows = this.#liveBlock(candidate.entry, candidate.index, width).rows.length;
			if (rows > 0) {
				const join = joinKey(candidate.entry.component);
				const gap = below === undefined ? 0 : separatorRows(tailKey(candidate.entry.component), below);
				const height = rows + gap + (cursor === lead ? 1 : 0);
				liveRows += height;
				if (fits) {
					if (tailRows + height > room) {
						fits = false;
						keep = cursor + 1;
						boundaryGap = gap;
						leadOnly = cursor === lead && tailRows + height - 1 <= room;
					} else {
						tailRows += height;
					}
				}
				below = join;
			}
			if (!fits && appendHead === undefined) break;
		}
		const overflowing = keep > 0 || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (policy === "pressure" && !overflowing && !eagerAppend) {
			this.#pinnedFrontier = undefined;
			return undefined;
		}
		if (leadOnly && policy === "pressure" && this.#liveCount() < MAX_LIVE_BLOCKS) {
			// Retire just that blank: every block's rows are still on screen.
			const batch: HistoryBatch = { id: this.#nextBatchId++, rows: [""], kind: "append" };
			this.#offered = { batch, kind: "commit", end: this.#frontier, historyEnd: undefined };
			this.#pinnedFrontier = undefined;
			return batch;
		}

		if (appendHead !== undefined && (keep > 0 || eagerAppend)) {
			// Emit as many finished rows as the overflow needs, in one batch. A
			// fast stream adds finished rows quicker than one per pressure cycle,
			// and the live region has to fall back under `room` to stay readable:
			// rows left behind here are rows dropped from the top of the viewport.
			// `liveRows` is exact here: the append path measured every live block.
			// A blank history owes the head goes out first, within the overflow.
			const leadRows = lead === 0 ? 1 : 0;
			const overflow = eagerAppend ? Number.POSITIVE_INFINITY : liveRows - room - leadRows;
			const { rows, emittedEnd } =
				this.#measuredAppendBatch(appendHead, width, overflow) ??
				this.#renderedAppendBatch(appendHead, width, overflow);
			if (this.completeScrollback && rows.length < overflow) this.#lockStreamingLayout(appendHead);
			if (emittedEnd > appendHead.emitted) {
				const batch: HistoryBatch = {
					id: this.#nextBatchId++,
					rows: leadRows > 0 ? ["", ...rows] : rows,
					kind: "append",
				};
				this.#offered = { batch, kind: "append", entry: this.#frontier, emittedEnd, lead: leadRows > 0 };
				this.#pinnedFrontier = undefined;
				return batch;
			}
		}

		// Shutdown retires everything eligible; pressure retires exactly the
		// blocks that no longer fit, plus whatever the live-block cap demands.
		let limit = this.#frontier + keep;
		if (this.#liveCount() >= MAX_LIVE_BLOCKS) {
			limit = Math.max(limit, this.#frontier + (this.#liveCount() - (MAX_LIVE_BLOCKS - 1)));
		}
		if (policy === "flush") limit = this.#entries.length;
		// Without explicit eager readiness, the boundary block publishes only
		// its displaced prefix. Its remaining rows keep their live ownership.
		// One exception: on a terminal that cannot draw part of an image, a cut
		// inside an image moves below it (cutBelowWholeImage), so up to that
		// image's height of on-screen rows commits early. A later shrink can then
		// open a band that tall, which beats losing the image.
		let split: { index: number; rows: readonly string[]; split: RowSplit } | undefined;
		if (policy === "pressure" && keep > 0 && limit === this.#frontier + keep) {
			const boundary = live[keep - 1]!;
			const visible = room - tailRows - boundaryGap;
			if (boundary.entry.state === "settled" && visible > 0) {
				const offer = this.#splitOffer(boundary.entry, width, visible);
				if (offer === "whole") {
					limit = boundary.index + 1;
				} else if (offer !== undefined) {
					split = { index: boundary.index, ...offer };
					limit = boundary.index;
				}
			}
		}
		let end = this.#frontier;
		while (end < limit && end < this.#entries.length && this.#entries[end]!.state === "settled") end++;
		if (split !== undefined && end !== split.index) split = undefined;
		if (end === this.#frontier && split === undefined) {
			if (policy === "pressure") {
				this.#notePinnedFrontier();
				// Floor-free compositors also need stable table widths before overflow leaves the viewport.
				if (keep > 0) this.#lockStreamingLayout(live[keep - 1]!.entry);
			}
			return undefined;
		}
		this.#pinnedFrontier = undefined;
		pushLoopPhase("ui.transcript-retire");
		let rows: string[];
		let historyEnd: RowsAbove;
		let reached: number;
		try {
			// Shutdown must hand over the full prefix; a live frame stops at the
			// budget and offers the rest on the next frames.
			const retirement = this.#renderRange(
				this.#frontier,
				end,
				width,
				this.#historyEnd,
				policy === "flush" ? undefined : RETIREMENT_BUDGET_MS,
			);
			rows = retirement.rows;
			reached = retirement.end;
			if (split !== undefined && reached !== split.index) split = undefined;
			if (split === undefined) {
				historyEnd = this.#closeRange(rows, retirement.above, reached, width);
			} else {
				if (separatorRows(retirement.above, joinKey(this.#entries[split.index]!.component)) > 0) rows.push("");
				rows.push(...split.rows);
			}
		} finally {
			popLoopPhase();
		}
		// With `completeScrollback`, a streaming block left at the top edge sends
		// the stable rows that no longer fit along with the blocks above it.
		// Offered on the next frame instead, they would be clipped off the top
		// of this frame's viewport with no copy in scrollback.
		let streamingHead: AppendBatch | undefined;
		if (this.completeScrollback && policy === "pressure" && split === undefined && keep > 0) {
			const boundary = live[keep - 1]!;
			const entry = boundary.entry;
			if (
				boundary.index === reached &&
				entry.mode === "appendOnly" &&
				!entry.stableFrozen &&
				entry.split === undefined &&
				entry.emitted < entry.stableRows.length
			) {
				const height = this.#liveBlock(entry, boundary.index, width).rows.length;
				const overflow = height + boundaryGap + tailRows - room;
				if (overflow > 0) {
					const batch =
						this.#measuredAppendBatch(entry, width, overflow) ??
						this.#renderedAppendBatch(entry, width, overflow);
					if (batch.emittedEnd > entry.emitted) streamingHead = batch;
					if (batch.rows.length < overflow) this.#lockStreamingLayout(entry);
				}
			}
		}
		// `#closeRange` already ended the retired rows with the separator the
		// streaming block is owed, so its rows follow directly and history then
		// ends inside that block.
		if (streamingHead !== undefined) {
			rows.push(...streamingHead.rows);
			historyEnd = undefined;
		}
		const batch: HistoryBatch = {
			id: this.#nextBatchId++,
			rows,
			kind: "append",
			divergent: this.#divergesFromHistory(width),
		};
		this.#offered = {
			batch,
			end: reached,
			kind: "commit",
			split: split?.split,
			headEmittedEnd: streamingHead?.emittedEnd,
			historyEnd,
		};
		return batch;
	}

	/** Publish explicit stages eagerly; append-only prose advances only under viewport pressure. */
	#offerReadyPrefix(width: number, capacity: number): HistoryBatch | undefined {
		let cursor = this.#frontier;
		let readyEnd = cursor;
		while (cursor < this.#entries.length && this.#entries[cursor]!.state === "settled") {
			if ((this.#entries[cursor]!.component as FinalizableBlock).commitToHistoryOnFinalize) {
				readyEnd = cursor + 1;
			}
			cursor++;
		}
		const head = this.#entries[cursor];
		let split: RowSplit | undefined;
		let prefix: readonly string[] = EMPTY_ROWS;
		if (head) {
			const block = head.component as Component & FinalizableBlock;
			if (block.getTranscriptReadyRowCount) {
				const measured = this.#measure(head, width).rows;
				const start = this.#emittedRowCount(head, width);
				const ready = block.getTranscriptReadyRowCount(width);
				const available = Math.max(0, ready - start);
				const pressure =
					head.mode === "appendOnly"
						? available > 0
							? Math.max(0, this.liveRowCount(width, capacity + available) - capacity)
							: 0
						: Infinity;
				const count = Math.min(ready, start + pressure);
				const stable = measured.slice(0, Math.max(0, count));
				// Preserve semantic-prefix admission when it can make progress.
				// A physical seam is needed only for an oversized stable prefix or
				// completed prose rows beyond the last closed Markdown block.
				const semanticFits =
					head.mode === "appendOnly" &&
					head.split === undefined &&
					head.emitted < head.stableRows.length &&
					this.#stablePrefixRowCount(head, head.emitted + 1, width) - start <= pressure;
				if (!semanticFits && stable.length > start) {
					split = rowSplit(stable, stable.length, width);
					prefix = stable.slice(start);
					readyEnd = cursor;
				}
			}
		}
		if (readyEnd === this.#frontier && split === undefined) return undefined;
		const retirement = this.#renderRange(this.#frontier, readyEnd, width, this.#historyEnd, RETIREMENT_BUDGET_MS);
		if (retirement.end !== readyEnd) {
			split = undefined;
			prefix = EMPTY_ROWS;
		}
		const rows = retirement.rows;
		let historyEnd: RowsAbove;
		if (split === undefined) {
			historyEnd = this.#closeRange(rows, retirement.above, retirement.end, width);
		} else {
			const head = this.#entries[retirement.end];
			if (head && separatorRows(retirement.above, joinKey(head.component)) > 0) rows.push("");
			rows.push(...prefix);
		}
		const batch: HistoryBatch = {
			id: this.#nextBatchId++,
			rows,
			kind: "append",
			divergent: this.#divergesFromHistory(width),
		};
		this.#offered = { batch, kind: "commit", end: retirement.end, split, historyEnd };
		return batch;
	}

	/**
	 * Whether the streamed block at the frontier no longer renders the rows it
	 * already published: an open markdown fence whose raw lines reached
	 * scrollback (as stable rows or a ready-row split), then closed into a box.
	 * Scrollback cannot be edited in place, so the batch is marked divergent and
	 * the writer replays the ledger once (see {@link HistoryBatch.divergent}).
	 */
	#divergesFromHistory(width: number): boolean {
		const head = this.#entries[this.#frontier];
		if (head === undefined || head.mode !== "appendOnly" || head.state === "committed") return false;
		const split = head.split;
		if (split === undefined && head.emitted === 0) return false;
		const rendered = trimBlankEdges(head.component.render(width));
		if (split !== undefined) {
			// A resize replays history anyway; only a same-width change of published rows diverges.
			return (
				split.width === width &&
				(rendered.length < split.rows || Bun.hash(rendered.slice(0, split.rows).join("\n")) !== split.hash)
			);
		}
		return !isRowPrefix(this.#renderStablePrefix(head, head.emitted, width), rendered);
	}

	/**
	 * The head rows of settled `entry` beyond its committed prefix that leave
	 * `visible` rows live, or undefined when nothing would remain committed
	 * past that prefix or the scrollback render would not line up row for row.
	 * `"whole"` when keeping an image whole moves the cut to the block's end:
	 * the block then retires in full, with the blank row that separates it from
	 * the next block, which a split never carries.
	 */
	#splitOffer(
		entry: TranscriptEntry,
		width: number,
		visible: number,
	): { rows: readonly string[]; split: RowSplit } | "whole" | undefined {
		const measured = this.#measure(entry, width).rows;
		const start = this.#emittedRowCount(entry, width);
		const cut = measured.length - visible;
		if (cut <= start) return undefined;
		// The boundary block stays live, so the viewport renders it in display
		// order; this render precedes the retired blocks and must claim no slot.
		const scrollback = measureRender(() => renderForScrollback(() => this.#renderEntry(entry, width))).value;
		if (scrollback.length !== measured.length) return undefined;
		const total = cutBelowWholeImage(scrollback, cut);
		if (total >= scrollback.length) return "whole";
		return { rows: scrollback.slice(start, total), split: rowSplit(scrollback, total, width) };
	}

	/** Acknowledges exactly the most recently offered append, commit, or replay transaction. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			// The offered end must still extend this entry's emitted prefix: a
			// stale offer (already-advanced entry) or a retraction (entry reset to
			// zero with the offer still live) must not move it backwards.
			if (entry === undefined || offered.entry !== this.#frontier || offered.emittedEnd <= entry.emitted) return;
			entry.emitted = offered.emittedEnd;
			this.#historyEnd = undefined;
		} else if (offered.kind === "commit") {
			for (let index = this.#frontier; index < offered.end; index++) {
				this.#retireEntry(this.#entries[index]!);
			}
			this.#frontier = offered.end;
			const head = offered.split ? this.#entries[offered.end] : undefined;
			if (head !== undefined) head.split = offered.split;
			this.#historyEnd = offered.historyEnd;
			const streamingEnd = offered.headEmittedEnd;
			const streaming = streamingEnd !== undefined ? this.#entries[offered.end] : undefined;
			if (streaming !== undefined && streamingEnd !== undefined && streamingEnd > streaming.emitted) {
				streaming.emitted = streamingEnd;
			}
		} else {
			this.#releaseCommittedRenderCaches();
			this.#historyEnd = offered.historyEnd;
		}
		this.#offered = undefined;
		if (this.#replayRequested) this.#startReplay();
	}

	/**
	 * Render only the trailing `maxRows` semantic rows, walking blocks bottom-up.
	 * Used by the transient resize-buffer repaint, which needs one viewport of
	 * tail rows per resize event — never the full committed ledger.
	 */
	renderTail(width: number, maxRows: number): readonly string[] {
		this.#enterFrame(width);
		const cap = Math.max(0, Math.trunc(maxRows));
		if (cap === 0) return EMPTY_ROWS;
		const rows: string[] = [];
		let below: RowsAbove;
		for (let index = this.#entries.length - 1; index >= 0; index--) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (entry.state === "committed") this.#releaseRenderCaches(entry);
			if (block.length === 0) continue;
			const join = joinKey(entry.component);
			if (below !== undefined && separatorRows(tailKey(entry.component), below) > 0) rows.unshift("");
			rows.unshift(...this.#clipViewportBlock(entry, width, Math.max(0, cap - rows.length), block));
			below = join;
			if (rows.length >= cap) break;
		}
		return rows.length > cap ? rows.slice(rows.length - cap) : rows;
	}

	/**
	 * The transcript's blocks for a native (TSP) surface, one `main` child
	 * per block in transcript order; ids follow component identity, so
	 * inserts, removals (rewind, displacement) and reorders become targeted ops.
	 * Finalized blocks are settled as a hint; they stay editable, so a later
	 * expansion, late result or reaction still reaches them wherever they sit.
	 * A block's {@link Component.nativeTrailers} follow it as blocks of their own.
	 * No retirement happens on this path: the whole transcript is one document.
	 *
	 * Each run of two or more consecutive compact blocks
	 * ({@link CompactTranscriptBlock}), with any blocks between them that
	 * describe nothing at `cx`, is one gapless entry whose members stay
	 * component children, keeping their own description, wire id and native
	 * events. A compact block's trailers are members of its run; a trailer of
	 * any other block is not. The entry is the same object while the same block
	 * leads the run, and it never settles: a member joining later may still be live.
	 *
	 * Returns the same array while the entries are unchanged.
	 */
	nativeBlocks(cx: DescribeContext): readonly Component[] {
		this.#syncEntries();
		const children = this.children;
		// Copies only once some block has trailers; `owners[i]` is the block whose compactness `flat[i]` takes.
		let flat: Component[] | undefined;
		let owners: Component[] | undefined;
		for (let i = 0; i < children.length; i++) {
			const child = children[i]!;
			if (!isNativeSettled(child) && isFinalized(child, true)) settleNative(child);
			flat?.push(child);
			owners?.push(child);
			const trailers = child.nativeTrailers?.();
			if (!trailers?.length) continue;
			flat ??= children.slice(0, i + 1);
			owners ??= children.slice(0, i + 1);
			for (const trailer of trailers) {
				flat.push(trailer);
				owners.push(child);
			}
		}
		const units: readonly Component[] = flat ?? children;
		const keyAt = (at: number): JoinKey => joinKey((owners ?? units)[at]!);
		// Copies only once a run forms.
		let blocks: Component[] | undefined;
		let runs: Map<Component, CompactRun> | undefined;
		let index = 0;
		while (index < units.length) {
			const first = units[index]!;
			let last = index;
			const key = keyAt(index);
			if (key !== null) {
				// The run reaches over blocks that describe nothing and ends at its last member with the same key.
				for (let probe = index + 1; probe < units.length; probe++) {
					if (keyAt(probe) === key) last = probe;
					else if (!describesNothing(units[probe]!, cx)) break;
				}
			}
			if (last === index) {
				blocks?.push(first);
				index++;
				continue;
			}
			const run = this.#nativeRuns.get(first) ?? new CompactRun();
			run.setMembers(units, index, last + 1, key === COMPACT_JOIN ? "omp.compact" : "omp.joined");
			(runs ??= new Map()).set(first, run);
			(blocks ??= units.slice(0, index)).push(run);
			index = last + 1;
		}
		this.#nativeRuns = runs ?? NO_RUNS;
		const next = blocks ?? units;
		if (sameItems(this.#nativeBlocks, next)) return this.#nativeBlocks;
		// `children` mutates in place: keep a snapshot.
		this.#nativeBlocks = next === children ? children.slice() : next;
		this.#nativeNode = undefined;
		return this.#nativeBlocks;
	}

	/** Embedded as a child (transcript viewers): a stack of the {@link nativeBlocks}. */
	override describe(cx: DescribeContext): NativeNode {
		const blocks = this.nativeBlocks(cx);
		this.#nativeNode ??= col(blocks, { role: "omp.transcript" });
		return this.#nativeNode;
	}

	/**
	 * Full semantic render used by exports, non-terminal commands, and transcript
	 * viewers. It writes no scrollback, so the append-only emission ledger is left
	 * to the frame path.
	 */
	override render(width: number): readonly string[] {
		this.#enterFrame(width);
		const components: Component[] = [];
		const blocks: (readonly string[])[] = [];
		const joins: JoinKey[] = [];
		const tails: JoinKey[] = [];
		let committed = false;
		for (const entry of this.#entries) {
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			components.push(entry.component);
			blocks.push(entry.component.render(width));
			joins.push(joinKey(entry.component));
			tails.push(tailKey(entry.component));
			if (entry.state === "committed") {
				committed = true;
				this.#releaseRenderCaches(entry);
			}
		}
		const memo = this.#fullRender;
		if (
			memo?.width === width &&
			sameItems(memo.components, components) &&
			sameItems(memo.blocks, blocks) &&
			sameItems(memo.joins, joins) &&
			sameItems(memo.tails, tails)
		) {
			return memo.rows;
		}
		this.#childStartRows.clear();
		const rows: string[] = [];
		let above: RowsAbove;
		for (let index = 0; index < blocks.length; index++) {
			const block = trimBlankEdges(blocks[index]!);
			if (block.length === 0) continue;
			if (separatorRows(above, joins[index]!) > 0) rows.push("");
			this.#childStartRows.set(components[index]!, rows.length);
			for (const row of block) rows.push(row);
			above = tails[index]!;
		}
		// Committed blocks drop their render caches, so they never return the same rows twice.
		this.#fullRender = committed ? undefined : { width, components, blocks, joins, tails, rows };
		return rows;
	}

	/** Rendered row where a child's block begins in the last full render() (transcript deep-links). */
	getChildStartRow(child: Component): number | undefined {
		return this.#childStartRows.get(child);
	}

	#renderEntry(entry: TranscriptEntry, width: number): readonly string[] {
		const rendered = trimBlankEdges(entry.component.render(width));
		if (entry.state === "committed" || entry.mode === "mutable" || entry.stableFrozen) return rendered;
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		const stable = appendOnly.getTranscriptStableRows();
		if (!isStablePrefix(entry.stableRows, stable)) {
			return this.#freezeStableRows(entry, rendered, "publication retracted the published prefix");
		}
		if (entry.emitted > stable.length) {
			return this.#freezeStableRows(entry, rendered, "publication retracted emitted history");
		}
		const published =
			stable.length > entry.stableRows.length
				? [...entry.stableRows, ...stable.slice(entry.stableRows.length)]
				: entry.stableRows;
		const stableRendered = appendOnly.renderTranscriptStableRows(published.length, width);
		if (!entry.stableRenderPrefix.holds(stableRendered, rendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows no longer render as a prefix of the block");
		}
		const priorRender = entry.renderedStableByWidth.get(width);
		if (priorRender && !isRowPrefix(priorRender, stableRendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows changed within a width epoch");
		}
		entry.stableRows = published;
		// The prefix check above proves equal-length rows are byte-identical.
		// Reuse our snapshot then; copy new rows so mutable renderer buffers
		// cannot change the bytes checked on the next frame.
		if (priorRender === undefined || priorRender.length !== stableRendered.length) {
			entry.renderedStableByWidth.set(width, stableRendered.slice());
		}
		let perCount = entry.stableRowCountByWidth.get(width);
		if (perCount === undefined) {
			perCount = new Map();
			entry.stableRowCountByWidth.set(width, perCount);
		}
		perCount.set(published.length, stableRendered.length);
		return rendered;
	}

	/**
	 * Demote a drifting append-only publication: rows already written to native
	 * scrollback cannot be retracted, so keep the last good stable state for
	 * emitted-row slicing and stop mid-stream emission for this block. The block
	 * still renders and retires whole on finalization; worst case is the old
	 * finalize-time behavior plus a possible stale-byte seam in scrollback.
	 */
	#freezeStableRows(entry: TranscriptEntry, rendered: readonly string[], reason: string): readonly string[] {
		entry.stableFrozen = true;
		logger.warn("Append-only transcript block frozen", { reason, emitted: entry.emitted });
		return rendered;
	}

	#renderStablePrefix(entry: TranscriptEntry, count: number, width: number): readonly string[] {
		if (count === 0) return EMPTY_ROWS;
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		return appendOnly.renderTranscriptStableRows(Math.min(count, entry.stableRows.length), width);
	}

	/**
	 * Rows of `entry` at `width` already in native history or in the
	 * unacknowledged offer: the row split when one is pending or committed,
	 * else its emitted stable prefix.
	 */
	#projectedEmittedRowCount(entry: TranscriptEntry, index: number, width: number): number {
		const offered = this.#offered;
		if (offered?.kind === "commit" && offered.split !== undefined && offered.end === index) {
			return this.#splitRowCount(entry, offered.split, width);
		}
		// A commit can carry the streaming head's rows too (completeScrollback).
		if (
			offered?.kind === "commit" &&
			offered.headEmittedEnd !== undefined &&
			offered.end === index &&
			entry.split === undefined
		) {
			return this.#stablePrefixRowCount(entry, offered.headEmittedEnd, width);
		}
		if (offered?.kind === "append" && offered.entry === index && entry.split === undefined) {
			return this.#stablePrefixRowCount(entry, offered.emittedEnd, width);
		}
		return this.#emittedRowCount(entry, width);
	}

	/** Rows of `entry` at `width` already acknowledged into native history. */
	#emittedRowCount(entry: TranscriptEntry, width: number): number {
		if (entry.split !== undefined) return this.#splitRowCount(entry, entry.split, width);
		return this.#stablePrefixRowCount(entry, entry.emitted, width);
	}

	/**
	 * Length-only variant of `#renderStablePrefix`: answers the emitted row
	 * count without re-rendering the prefix when this width already recorded it.
	 */
	#stablePrefixRowCount(entry: TranscriptEntry, count: number, width: number): number {
		if (count === 0) return 0;
		const perCount = entry.stableRowCountByWidth.get(width);
		const memo = perCount?.get(Math.min(count, entry.stableRows.length));
		if (memo !== undefined) return memo;
		return this.#renderStablePrefix(entry, count, width).length;
	}

	/**
	 * Rows of `entry`'s current render at `width` that `split` committed: all
	 * of them while they render unchanged, else the longest prefix whose
	 * content continues the committed text exactly. A row the seam falls
	 * inside, a row the block changed, a row with no content (a rule or other
	 * punctuation the block revealed), or one whose decoration reads as
	 * content stays live: it can repeat committed text but never drop any.
	 */
	#splitRowCount(entry: TranscriptEntry, split: RowSplit, width: number): number {
		const rendered = this.#measure(entry, width).rows;
		if (split.located?.rendered === rendered) return split.located.count;
		let count = 0;
		if (
			width === split.width &&
			rendered.length >= split.rows &&
			Bun.hash(rendered.slice(0, split.rows).join("\n")) === split.hash
		) {
			count = split.rows;
		} else {
			let consumed = 0;
			let image = 0;
			while (count < rendered.length && (consumed < split.text.length || image < split.images.length)) {
				const row = rendered[count]!;
				const content = contentOf([row]);
				if (content.length > 0) {
					if (!split.text.startsWith(content, consumed)) break;
					consumed += content.length;
					count++;
					continue;
				}
				// An empty-content row matches at any offset, so the walk cannot tell it
				// apart from a revealed row history never received; only the next
				// archived image carries the seam on, through its own reserved rows to
				// its row, whatever its height here.
				let index = count;
				while (
					index < rendered.length &&
					!TERMINAL.isImageLine(rendered[index]!) &&
					contentOf([rendered[index]!]).length === 0
				) {
					index++;
				}
				const imageRow = rendered[index];
				if (
					imageRow === undefined ||
					!TERMINAL.isImageLine(imageRow) ||
					(iterm2ImagePayload(imageRow) ?? imageRow) !== split.images[image]?.payload ||
					consumed !== split.images[image]?.offset ||
					index - count !== directPlacementLift(imageRow)
				) {
					break;
				}
				count = index + 1;
				image++;
			}
		}
		split.located = { rendered, count };
		return count;
	}

	/**
	 * Size a progressive-append batch from the stable renders `#renderEntry`
	 * recorded at this width, without rendering any prefix. Each recorded count
	 * was checked to render as a byte prefix of every later one, and
	 * `renderedStableByWidth` holds the newest, so each count's rows are a
	 * prefix of it and the batch is one slice. Undefined when a count the walk
	 * needs was never recorded here (published between renders, or before a
	 * resize); the rendered walk then decides. It sizes the batch the way the
	 * rendered walk does.
	 */
	#measuredAppendBatch(entry: TranscriptEntry, width: number, overflow: number): AppendBatch | undefined {
		const counts = entry.stableRowCountByWidth.get(width);
		const newest = entry.renderedStableByWidth.get(width);
		const target = entry.stableRows.length;
		if (counts === undefined || newest === undefined || counts.get(target) !== newest.length) return undefined;
		const start = entry.emitted === 0 ? 0 : counts.get(entry.emitted);
		if (start === undefined) return undefined;
		let emittedEnd = entry.emitted;
		let end = start;
		while (emittedEnd < target && !(this.completeScrollback && end - start >= overflow)) {
			const next = counts.get(emittedEnd + 1);
			if (next === undefined) return undefined;
			if (next <= start) {
				if (emittedEnd === entry.emitted) {
					this.#freezeStableRows(entry, EMPTY_ROWS, "semantic row render added no suffix");
				}
				break;
			}
			if (!this.completeScrollback && next - start > overflow) break;
			end = next;
			emittedEnd += 1;
		}
		return { rows: emittedEnd > entry.emitted ? newest.slice(start, end) : EMPTY_ROWS, emittedEnd };
	}

	/**
	 * Size a progressive-append batch by rendering each further stable prefix,
	 * stopping early at a prefix that adds no row or changes earlier bytes (freezing
	 * the block when that is the very next prefix). Pressure limits it to displaced
	 * rows; eager semantic publishers use an infinite limit. By default the batch
	 * stays within `overflow`, the rows that left the screen: a prefix still partly on
	 * screen stays live, because committing it would strand those rows above the live
	 * tail, where a later shrink of the chrome below opens a band no frame can fill.
	 * With `completeScrollback` the batch is the shortest prefix that covers
	 * `overflow`, since a prefix held back is clipped off the top of the viewport
	 * with no copy anywhere.
	 */
	#renderedAppendBatch(entry: TranscriptEntry, width: number, overflow: number): AppendBatch {
		const before = this.#renderStablePrefix(entry, entry.emitted, width);
		let emittedEnd = entry.emitted;
		let after = before;
		while (
			emittedEnd < entry.stableRows.length &&
			!(this.completeScrollback && after.length - before.length >= overflow)
		) {
			const next = this.#renderStablePrefix(entry, emittedEnd + 1, width);
			if (!isRowPrefix(before, next) || next.length === before.length) {
				if (emittedEnd === entry.emitted) {
					this.#freezeStableRows(entry, EMPTY_ROWS, "semantic row render added no suffix");
				}
				break;
			}
			if (!this.completeScrollback && next.length - before.length > overflow) break;
			after = next;
			emittedEnd += 1;
		}
		return { rows: emittedEnd > entry.emitted ? after.slice(before.length) : EMPTY_ROWS, emittedEnd };
	}

	/**
	 * Leave a trace when the live region holds more blocks than the viewport has rows,
	 * which collapses tool cards to their header. The log names the oldest block that is
	 * not finalized, so the next occurrence shows whether a stuck block or only a short
	 * viewport caused it. Logged when the situation changes and at most once a minute.
	 */
	#noteDegradedViewport(
		live: readonly { entry: TranscriptEntry; index: number }[],
		shown: number,
		capacity: number,
		firstUnsettled: number,
	): void {
		const oldest = firstUnsettled >= 0 ? live[firstUnsettled] : undefined;
		const signature = `${live.length}:${oldest?.index ?? -1}:${capacity}`;
		const now = Date.now();
		const last = this.#degradedViewport;
		if (last !== undefined && (last.signature === signature || now - last.at < DEGRADED_VIEWPORT_LOG_INTERVAL_MS)) {
			return;
		}
		this.#degradedViewport = { signature, at: now };
		const active = live.reduce((count, { entry }) => count + (entry.state === "active" ? 1 : 0), 0);
		logger.warn("Transcript viewport has more live blocks than rows", {
			liveBlocks: live.length,
			collected: shown,
			rows: capacity,
			active,
			oldestUnfinalized: oldest
				? {
						position: firstUnsettled,
						component: oldest.entry.component.constructor.name,
						state: oldest.entry.state,
						mode: oldest.entry.mode,
						rows: renderForScrollback(() => trimBlankEdges(oldest.entry.component.render(120)))
							.slice(0, 2)
							.map(row => Bun.stripANSI(row).trim()),
					}
				: undefined,
		});
	}
	/**
	 * Record that pressure retirement is blocked behind a not-yet-settled
	 * frontier block, and log its identity once the episode outlives the grace
	 * period. A block that never finalizes (a dropped terminal event) pins the
	 * whole live region here with no visible symptom other than degraded
	 * one-line layout, so the log line is the only forensic trail.
	 */
	#notePinnedFrontier(): void {
		const entry = this.#entries[this.#frontier];
		if (entry === undefined) return;
		const now = Date.now();
		if (this.#pinnedFrontier?.index !== this.#frontier) {
			this.#pinnedFrontier = { index: this.#frontier, since: now, logged: false };
			return;
		}
		if (this.#pinnedFrontier.logged || now - this.#pinnedFrontier.since < PINNED_FRONTIER_WARN_MS) return;
		this.#pinnedFrontier.logged = true;
		// Observe only: a block cannot be forced terminal, because a tool that is merely
		// quiet may still stream output that would then be lost. The first rows name it.
		logger.warn("Transcript retirement pinned by unfinalized frontier block", {
			component: entry.component.constructor.name,
			state: entry.state,
			mode: entry.mode,
			liveBlocks: this.#liveCount(),
			rows: renderForScrollback(() => trimBlankEdges(entry.component.render(120)))
				.slice(0, 2)
				.map(row => Bun.stripANSI(row).trim()),
		});
	}

	/**
	 * Compose entries `[start, end)` as one ordered retirement payload below
	 * rows ending as `above` says, without the separator the last block owes
	 * what follows (see {@link #closeRange}).
	 *
	 * `budgetMs` stops the walk after the first block that crosses it — always
	 * at least one block — and reports the index actually reached, so a single
	 * frame never renders more of a resumed ledger than it can afford (#12933).
	 * Callers that must emit a whole prefix (replay, shutdown flush, recompose
	 * of an already offered batch) omit it.
	 */
	#renderRange(
		start: number,
		end: number,
		width: number,
		above: RowsAbove,
		budgetMs?: number,
	): { rows: string[]; end: number; above: RowsAbove } {
		const rows: string[] = [];
		const startedAt = budgetMs === undefined ? 0 : performance.now();
		let reached = start;
		for (let index = start; index < end; index++) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			// Only the range head is sliced by its emitted stable prefix; every other
			// entry renders whole, so the append-only verification pass (a second
			// full render of the block's stable prefix) is skipped for them. This
			// keeps a complete-ledger replay at one render per block. These rows go
			// to native scrollback, where nothing can repaint them.
			const rendered = renderForScrollback(() =>
				index === start ? this.#renderEntry(entry, width) : trimBlankEdges(entry.component.render(width)),
			);
			const emittedRows = index === start ? this.#emittedRowCount(entry, width) : 0;
			const block = rendered.slice(emittedRows);
			reached = index + 1;
			if (block.length > 0) {
				const join = joinKey(entry.component);
				if (separatorRows(above, join) > 0) rows.push("");
				rows.push(...block);
				above = tailKey(entry.component);
			}
			if (budgetMs !== undefined && performance.now() - startedAt >= budgetMs) break;
		}
		return { rows, end: reached, above };
	}

	/**
	 * End retired `rows` with the separator their last block owes the first
	 * non-empty live block from `next`, withheld when both share a join key,
	 * and return what history then ends with. After a joinable block with no
	 * non-empty live block yet, the separator stays owed: the next block's
	 * lead row (see {@link #owedLead}) draws it unless that block packs.
	 */
	#closeRange(rows: string[], above: RowsAbove, next: number, width: number): RowsAbove {
		if (above === undefined) return undefined;
		if (above !== null) {
			for (let index = next; index < this.#entries.length; index++) {
				const entry = this.#entries[index]!;
				if (this.#liveBlock(entry, index, width).rows.length === 0) continue;
				if (joinKey(entry.component) === above) return above;
				rows.push("");
				return undefined;
			}
			return above;
		}
		rows.push("");
		return undefined;
	}

	/** The committed ledger and the head rows already in history, and what that history ends with. */
	#renderReplay(width: number): { rows: readonly string[]; historyEnd: RowsAbove } {
		const range = this.#renderRange(0, this.#frontier, width, undefined);
		const head = this.#entries[this.#frontier];
		let headRows: readonly string[] = EMPTY_ROWS;
		if (head?.split !== undefined) {
			this.#setAllocation(head.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const committed = this.#splitRowCount(head, head.split, width);
			headRows = renderForScrollback(() => this.#renderEntry(head, width)).slice(0, committed);
		} else if (head?.mode === "appendOnly" && head.emitted > 0) {
			this.#setAllocation(head.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			this.#renderEntry(head, width);
			headRows = this.#renderStablePrefix(head, head.emitted, width);
		}
		if (head === undefined || headRows.length === 0) {
			return { rows: range.rows, historyEnd: this.#closeRange(range.rows, range.above, this.#frontier, width) };
		}
		if (separatorRows(range.above, joinKey(head.component)) > 0) range.rows.push("");
		range.rows.push(...headRows);
		return { rows: range.rows, historyEnd: undefined };
	}

	#completeFullyEmittedHeads(width: number): void {
		while (this.#frontier < this.#entries.length) {
			const entry = this.#entries[this.#frontier]!;
			if (entry.state !== "settled") return;
			if (entry.split !== undefined) {
				if (this.#splitRowCount(entry, entry.split, width) < this.#measure(entry, width).rows.length) return;
			} else {
				if (entry.mode !== "appendOnly") return;
				const rendered = this.#measure(entry, width).rows;
				if (entry.emitted !== entry.stableRows.length) return;
				// Same height is not enough: a fence that closed into a box can match the raw rows' count.
				const published = this.#renderStablePrefix(entry, entry.emitted, width);
				if (published.length !== rendered.length || !isRowPrefix(published, rendered)) return;
			}
			this.#retireEntry(entry);
			this.#frontier++;
		}
	}

	#retireEntry(entry: TranscriptEntry): void {
		entry.state = "committed";
		entry.emitted = 0;
		entry.split = undefined;
		entry.stableRows = EMPTY_STABLE_ROWS;
		entry.renderedStableByWidth = new Map();
		entry.stableRowCountByWidth = new Map();
		entry.stableRenderPrefix = new RowPrefixCheck();
		this.#frameRows.delete(entry);
		this.#releaseRenderCaches(entry);
	}

	#releaseCommittedRenderCaches(): void {
		for (let index = 0; index < this.#frontier; index++) {
			this.#releaseRenderCaches(this.#entries[index]!);
		}
	}

	#releaseRenderCaches(entry: TranscriptEntry): void {
		const release = entry.component.releaseRenderCaches;
		if (release === undefined) return;
		try {
			release.call(entry.component);
		} catch (err) {
			if (this.#releaseFailures.has(entry.component)) return;
			this.#releaseFailures.add(entry.component);
			logger.warn("Transcript block failed to release render caches", {
				component: entry.component.constructor.name,
				error: String(err),
			});
		}
	}

	#startReplay(): void {
		const head = this.#entries[this.#frontier];
		this.#replayPending =
			this.#allowEmptyReplay ||
			this.#frontier > 0 ||
			head?.split !== undefined ||
			(head?.mode === "appendOnly" && head.emitted > 0);
		this.#replayRequested = false;
	}

	/** A streaming block that overflows with too few stable rows to cover it. */
	#lockStreamingLayout(entry: TranscriptEntry): void {
		if (entry.state === "settled") return;
		(entry.component as Component & TranscriptPresentationTarget).lockStreamingLayout?.();
	}

	#setAllocation(component: Component, rows: number, frame: AnimationFrame): void {
		(component as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(rows, frame);
	}

	/** Reconcile reconstructed blocks against already-published rows before measuring a frame. */
	#enterFrame(width: number): void {
		this.#syncEntries();
		this.#reconcileRebuild();
		this.#lastWidth = width;
		this.#settleFinalized();
		this.#assignJoinRuns(width);
		if (this.#replayRequested && this.#offered === undefined) this.#startReplay();
	}

	/**
	 * Tell each live joinable block whether it ends its run: the last block of a
	 * run that counts at least two items draws the total under itself, like a
	 * read group's `• Read (N)`; the others draw nothing. Committed blocks keep
	 * what they drew, and a run never continues below one that drew a total.
	 */
	#assignJoinRuns(width: number): void {
		const entries = this.#entries;
		for (let index = this.#frontier; index < entries.length; index++) {
			const entry = entries[index]!;
			const block = entry.component as Component & CompactTranscriptBlock;
			if (entry.state === "committed" || block.setTranscriptJoinRun === undefined) continue;
			const key = joinKey(entry.component);
			if (key === null || key === COMPACT_JOIN) {
				block.setTranscriptJoinRun(undefined);
				continue;
			}
			let next = index + 1;
			while (
				next < entries.length &&
				joinKey(entries[next]!.component) !== key &&
				this.#measure(entries[next]!, width).rows.length === 0
			) {
				next++;
			}
			const continues = next < entries.length && joinKey(entries[next]!.component) === key;
			block.setTranscriptJoinRun(continues ? undefined : this.#runTotal(index, key, width));
		}
	}

	/** Items in the run ending at `index`, counted back to its start; `undefined` below two. */
	#runTotal(index: number, key: string, width: number): number | undefined {
		let total = 0;
		for (let at = index; at >= 0; at--) {
			const entry = this.#entries[at]!;
			const block = entry.component as Component & CompactTranscriptBlock;
			if (joinKey(entry.component) === key) {
				if (at < index && block.transcriptJoinRun?.() !== undefined) break;
				total += block.transcriptJoinCount?.() ?? 1;
			} else if (this.#measure(entry, width).rows.length > 0) {
				break;
			}
		}
		return total >= 2 ? total : undefined;
	}

	#reconcileRebuild(): void {
		const ledger = this.#rebuildLedger;
		if (ledger === undefined) return;
		this.#rebuildLedger = undefined;
		if (this.#entries.length === 0) return;
		const width = ledger.width;
		const rows = ledger.rows;
		let cursor = 0;
		let index = 0;
		// What the matched ledger ends with, under the same separator rule as retirement.
		let historyEnd: RowsAbove;
		let partial = false;
		for (; index < this.#entries.length; index++) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry.component, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			const join = joinKey(entry.component);
			const gap = cursor > 0 ? separatorRows(historyEnd, join) : 0;
			const start = cursor + gap;
			if (gap > 0 && rows[cursor] !== "") break;
			let matched = 0;
			while (matched < block.length && start + matched < rows.length && rows[start + matched] === block[matched])
				matched++;
			if (matched < block.length) {
				// The head may have been emitted only partway; keep that prefix.
				if (matched > 0) {
					this.#adoptEmittedPrefix(entry, block, matched, width);
					partial = true;
				}
				break;
			}
			// A complete match followed by more ledger rows is a committed block;
			// a match that exhausts the ledger is the head's emitted prefix only
			// when it was not closed by a separator.
			cursor = start + block.length;
			if (cursor === rows.length) {
				this.#adoptEmittedPrefix(entry, block, block.length, width);
				partial = true;
				break;
			}
			historyEnd = tailKey(entry.component);
		}
		this.#historyEnd = partial ? undefined : historyEnd;
		for (let committed = 0; committed < index; committed++) {
			const entry = this.#entries[committed]!;
			entry.state = "committed";
			entry.emitted = 0;
		}
		this.#frontier = index;
	}

	#adoptEmittedPrefix(entry: TranscriptEntry, block: readonly string[], rowCount: number, width: number): void {
		if (entry.mode === "mutable") {
			entry.split = rowSplit(block, rowCount, width);
			return;
		}
		// Append-only blocks count emitted rows in stable semantic units; adopt
		// the largest published count whose render fits inside the matched rows.
		this.#renderEntry(entry, width);
		let count = 0;
		while (count < entry.stableRows.length) {
			const prefix = this.#renderStablePrefix(entry, count + 1, width);
			if (prefix.length > rowCount || !isRowPrefix(prefix, block)) break;
			count++;
		}
		entry.emitted = count;
	}
	#settleFinalized(): void {
		for (let index = this.#frontier; index < this.#entries.length; index++) {
			const entry = this.#entries[index]!;
			// Late image conversion can make an unpublished settled block pending
			// again. Preserve emitted prefixes, but do not retire its unfinished tail.
			if (entry.state !== "committed") entry.state = isFinalized(entry.component) ? "settled" : "active";
		}
	}

	#liveEntries(): ReadonlyArray<{ entry: TranscriptEntry; index: number }> {
		const start = this.#offered?.kind === "commit" ? this.#offered.end : this.#frontier;
		const cached = this.#liveWrappers;
		if (
			start === this.#liveWrappersStart &&
			cached.length === this.#entries.length - start &&
			cached.every((wrapper, offset) => wrapper.entry === this.#entries[start + offset])
		) {
			return cached;
		}
		const live: Array<{ entry: TranscriptEntry; index: number }> = [];
		for (let index = start; index < this.#entries.length; index++) live.push({ entry: this.#entries[index]!, index });
		this.#liveWrappers = live;
		this.#liveWrappersStart = start;
		return live;
	}

	#liveCount(): number {
		return this.#entries.length - this.#frontier;
	}

	/**
	 * Mirror `children` into `#entries`. The container's own add/remove/clear
	 * keep the two aligned, so the per-frame check stays off the committed
	 * ledger: external edits to the public `children` array are caught by array
	 * identity (replacement), length (push, removing splices), and an identity
	 * scan of the live tail (in-place reorders and index writes). Committed
	 * blocks are immutable history nothing reorders, and the scan skipping
	 * them keeps this proportional to the live tail rather than the session.
	 */
	#syncEntries(): void {
		const children = this.children;
		if (
			!this.#entriesUnverified &&
			children === this.#syncedChildren &&
			this.#entriesMatch(children, this.#frontier)
		) {
			return;
		}
		this.#entriesUnverified = false;
		this.#syncedChildren = children;
		if (this.#entriesMatch(children, 0)) return;
		const existing = new Map(this.#entries.map(entry => [entry.component, entry]));
		this.#entries = this.children.map(
			component =>
				existing.get(component) ?? {
					component,
					state: "active",
					mode: blockMode(component),
					stableRows: EMPTY_STABLE_ROWS,
					renderedStableByWidth: new Map(),
					stableRowCountByWidth: new Map(),
					emitted: 0,
					stableFrozen: false,
					stableRenderPrefix: new RowPrefixCheck(),
					split: undefined,
				},
		);
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
	}

	/** Whether `#entries` has `children`'s length and components from `start` on. */
	#entriesMatch(children: readonly Component[], start: number): boolean {
		const entries = this.#entries;
		if (entries.length !== children.length) return false;
		for (let index = start; index < entries.length; index++) {
			if (entries[index]!.component !== children[index]) return false;
		}
		return true;
	}
}

/** Groups sibling rows into one conservative mutable semantic transcript block. */
export class TranscriptBlock extends Container {}
