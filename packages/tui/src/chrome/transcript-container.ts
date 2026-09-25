import { type Component, Container, type HistoryBatch } from "../tui";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { isToolActivityComponent } from "./tool-activity";

/** Shared animation time supplied by the constrained transcript root. */
export interface AnimationFrame {
	readonly tick: number;
	readonly now: number;
}

/** Lets an active block adapt its presentation to its allocated viewport rows. */
export interface TranscriptPresentationTarget {
	setTranscriptAllocation?(rows: number, frame: AnimationFrame): void;
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
	isTranscriptBlockFinalized?(): boolean;
	commitToHistoryOnFinalize?: boolean;
	/**
	 * Whether the block's height is still reversible: it grows while it runs and
	 * collapses when it settles or disappears. Those rows must expand the
	 * viewport budget instead of retiring transcript rows they will hand back.
	 */
	isTranscriptBlockTransient?(): boolean;
	/** Render the row that must remain represented under emergency viewport pressure. */
	renderTranscriptBlockEmergencyRow?(width: number): string | undefined;
	/** Number of leading raw rows whose bytes are final while the block remains active. */
	getTranscriptBlockSettledRows?(): number;
}

/**
 * Block lifecycle:
 * - `active`: still mutating; renders live and counts against tool admission.
 * - `settled`: finalized but retained in the mutable viewport until pressure.
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
	/** Position in the last logical live viewport; independent of durable retirement. */
	viewportStart?: number;
	borrowed?: boolean;
	viewportOffset?: number;
	viewportExtent?: number;
	/** Actual viewport rows this entry already owns in native scrollback (including its trailing separator). */
	borrowedRows?: readonly string[];
	borrowedEnd?: number;
	/**
	 * A streamed block re-rendered rows it had already lent to native history
	 * (an open markdown fence closing into a frame). Native scrollback still
	 * holds the old form, so the batch that retires the block must replay.
	 */
	historyDirty?: boolean;
	/**
	 * Set when a published stable row drifted (retraction, byte change within a
	 * width epoch, or no longer a render prefix). Rows already in native
	 * scrollback cannot be retracted, so the entry keeps its last good stable
	 * state for emitted-row slicing but never emits another mid-stream row.
	 */
	stableFrozen: boolean;
	/**
	 * One render per frame. Composition walks the live entries several times
	 * per paint (transient measurement, viewport render, history offer, row
	 * count), and without this each walk re-rendered every live block - a cost
	 * that grew with the session and froze the UI for seconds on long ones.
	 * Keyed on the frame OBJECT, not its tick: a tick is an 80 ms bucket and
	 * two paints can share one while a streaming block changed between them.
	 * Every `renderFrame` builds a fresh frame object, so identity means "this
	 * exact paint". Width and allocation complete the key because different
	 * walks shape the same block differently.
	 */
	frameMemo?: { frame: AnimationFrame; width: number; allocation: number; rows: readonly string[] };
	/** Allocation most recently applied through `#setAllocation`. */
	allocation: number;
	/**
	 * Tallest live height this block reached at a width. A live block is held
	 * at this height until it settles so its card never contracts mid-run.
	 */
	peakLiveRows?: { width: number; rows: number };
}

type RetirementPolicy = "pressure" | "flush";
type Offered =
	| { batch: HistoryBatch; kind: "append"; entry: number; emittedEnd: number }
	| { batch: HistoryBatch; kind: "commit"; end: number }
	| { batch: HistoryBatch; kind: "replay" };

const MAX_LIVE_BLOCKS = 256;
/** Grace before a pressure-blocked frontier is reported; a streaming block may legitimately hold it briefly. */
const PINNED_FRONTIER_WARN_MS = 30_000;
const EMPTY_ROWS: readonly string[] = [];
const EMPTY_STABLE_ROWS: readonly TranscriptStableRow[] = [];

function isFinalized(component: Component): boolean {
	const block = component as Component & FinalizableBlock;
	return block.isTranscriptBlockFinalized?.() ?? true;
}

function isTransient(component: Component): boolean {
	return (component as Component & FinalizableBlock).isTranscriptBlockTransient?.() ?? false;
}

function blockMode(component: Component): TranscriptBlockMode {
	return (component as Component & Partial<AppendOnlyTranscriptBlock>).transcriptBlockMode === "appendOnly"
		? "appendOnly"
		: "mutable";
}

function isPlainBlank(line: string): boolean {
	return !/\S/.test(line);
}

/** Whether `prefix` matches `rows` byte-for-byte from the top. */
export function isRowPrefix(prefix: readonly string[], rows: readonly string[]): boolean {
	if (prefix.length > rows.length) return false;
	for (let index = 0; index < prefix.length; index++) {
		if (prefix[index] !== rows[index]) return false;
	}
	return true;
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

export interface LiveViewportFrame {
	/** Complete editable rows, including the reserve outside the physical window. */
	readonly rows: readonly string[];
	readonly capacity: number;
	readonly physicalRows: number;
	/** Prefix safe to append; active tool previews remain replaceable on screen. */
	readonly borrowableRows?: number;
}

/** One live block's row span in the last `renderViewport` output (half-open `[start, end)`). */
export interface TranscriptViewportSpan {
	component: Component;
	start: number;
	end: number;
}

/** Owns transcript order, live capacity, and ordered immutable retirement. */
export class TranscriptContainer extends Container {
	#entries: TranscriptEntry[] = [];
	#frontier = 0;
	#nextBatchId = 1;
	#offered: Offered | undefined;
	#replayPending = false;
	#replayRequested = false;
	#toolActivityVisible = true;
	#lastFrame: AnimationFrame = { tick: 0, now: 0 };
	/** The paint currently being composed, between beginPaint and endPaint; scopes the per-entry render memo. */
	#paintFrame: AnimationFrame | undefined;
	#liveViewport: LiveViewportFrame = { rows: [], capacity: 0, physicalRows: 0 };
	// Start rows from the last full render(), keyed by child component (transcript deep-links).
	#childStartRows = new Map<Component, number>();
	// Watchdog for the wedge where an unfinalized frontier block pins pressure
	// retirement: everything behind it stays live and degrades to one-line
	// allocations. Logs once per pinned episode after a grace period.
	#pinnedFrontier: { index: number; since: number; logged: boolean } | undefined;
	/** Block spans of the last `renderViewport` output, for click hit-testing. */
	#lastViewportSpans: TranscriptViewportSpan[] = [];
	/** Width of the last terminal-facing render; the rebuild ledger is only comparable at this width. */
	#lastWidth: number | undefined;
	/**
	 * What native scrollback holds from the transcript that {@link clear} threw
	 * away: the committed blocks plus the frontier head's emitted prefix. The
	 * next render at the same width reconciles the rebuilt entries against it
	 * so rows already in native history are not offered as a fresh append.
	 */
	#rebuildLedger: { width: number; rows: readonly string[]; borrowed: readonly string[] } | undefined;
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
			allocation: Number.POSITIVE_INFINITY,
		});
	}

	override removeChild(component: Component): void {
		if (this.children.indexOf(component) < 0 || !this.canRemoveBlock(component)) return;
		super.removeChild(component);
		this.#entries = this.#entries.filter(candidate => candidate.component !== component);
		this.#frontier = Math.min(this.#frontier, this.#entries.length);
		this.#childStartRows.delete(component);
	}

	override clear(): void {
		// Rebuilds (`/shake`, compaction, cancel/restore of a submission) replace
		// every block with a reconstructed equivalent. The ledger of what already
		// reached native scrollback must survive the swap, or the reconstruction
		// starts at emitted=0 and re-commits those rows a second time.
		this.#syncEntries();
		const width = this.#lastWidth;
		const ledger =
			width !== undefined && this.#entries.length > 0 && this.#offered?.kind !== "replay"
				? this.#renderReplay(width)
				: EMPTY_ROWS;
		// Leading live rows the terminal already borrowed into native scrollback
		// are just as unrepeatable as committed ones; keep them so the rebuilt
		// live entries inherit their borrowed ownership.
		const borrowed = this.#liveViewport.rows.slice(0, this.borrowedViewportRowCount());
		super.clear();
		this.#entries = [];
		this.#frontier = 0;
		this.#offered = undefined;
		this.#childStartRows.clear();
		this.#pinnedFrontier = undefined;
		this.#replayPending = false;
		this.#replayRequested = false;
		this.#liveViewport = { rows: [], capacity: 0, physicalRows: 0 };
		this.#lastViewportSpans = [];
		this.#rebuildLedger =
			width !== undefined && (ledger.length > 0 || borrowed.length > 0)
				? { width, rows: ledger, borrowed }
				: undefined;
	}

	/** Common prologue of every terminal-facing render at `width`. */
	#enterFrame(width: number): void {
		this.#syncEntries();
		this.#lastWidth = width;
		this.#reconcileRebuild(width);
		this.#settleFinalized();
	}

	/**
	 * After a rebuild, mark reconstructed blocks that render byte-identical to
	 * the committed ledger as committed, and give a partially matching head the
	 * emitted prefix native scrollback already holds. The first divergent block
	 * and everything after it stay live, so only genuinely new rows are offered.
	 */
	#reconcileRebuild(width: number): void {
		const ledger = this.#rebuildLedger;
		if (ledger === undefined) return;
		this.#rebuildLedger = undefined;
		if (ledger.width !== width || this.#entries.length === 0) return;
		const rows = ledger.rows;
		let cursor = 0;
		let index = 0;
		for (; index < this.#entries.length; index++) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			const start = cursor > 0 ? cursor + 1 : 0;
			if (cursor > 0 && rows[cursor] !== "") break;
			if (start + block.length > rows.length) break;
			let matched = 0;
			while (matched < block.length && rows[start + matched] === block[matched]) matched++;
			if (matched < block.length) {
				// The head may have been emitted only partway; keep that prefix.
				if (matched > 0) this.#adoptEmittedPrefix(entry, block, matched, width);
				break;
			}
			// A complete match followed by more ledger rows is a committed block;
			// a match that exhausts the ledger is the head's emitted prefix only
			// when it was not closed by a separator.
			cursor = start + block.length;
			if (cursor === rows.length) {
				this.#adoptEmittedPrefix(entry, block, block.length, width);
				break;
			}
		}
		for (let committed = 0; committed < index; committed++) {
			const entry = this.#entries[committed]!;
			entry.state = "committed";
			entry.emitted = 0;
		}
		this.#frontier = index;
		this.#adoptBorrowedRows(index, ledger.borrowed, width);
	}

	/** Re-flag the leading live rows that native scrollback already borrowed from the pre-rebuild viewport. */
	#adoptBorrowedRows(start: number, borrowed: readonly string[], width: number): void {
		let cursor = 0;
		for (let index = start; index < this.#entries.length && cursor < borrowed.length; index++) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const offset = this.#renderStablePrefix(entry, entry.emitted, width).length;
			const block = this.#renderEntry(entry, width).slice(offset);
			if (block.length === 0) continue;
			const entryStart = cursor;
			let matched = 0;
			while (
				matched < block.length &&
				cursor + matched < borrowed.length &&
				borrowed[cursor + matched] === block[matched]
			)
				matched++;
			if (matched === 0) return;
			cursor += matched;
			// A fully borrowed block also owns the separator row that follows it,
			// exactly as `setBorrowedViewportRows` counts it from the live extent.
			const separator = matched === block.length && cursor < borrowed.length && borrowed[cursor] === "" ? 1 : 0;
			cursor += separator;
			entry.borrowed = true;
			entry.borrowedEnd = offset + matched + separator;
			entry.borrowedRows = borrowed.slice(entryStart, cursor);
			entry.viewportOffset = offset;
			if (matched < block.length) return;
		}
	}

	#adoptEmittedPrefix(entry: TranscriptEntry, block: readonly string[], rowCount: number, width: number): void {
		if (entry.mode === "mutable") {
			entry.emitted = rowCount;
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
		this.#syncEntries();
		if (this.#offered?.kind === "append") this.#offered = undefined;
		for (const entry of this.#entries) {
			entry.borrowed = false;
			entry.borrowedEnd = 0;
			entry.borrowedRows = undefined;
			entry.viewportStart = undefined;
			entry.emitted = 0;
			entry.stableRows = EMPTY_STABLE_ROWS;
			entry.renderedStableByWidth = new Map();
			entry.stableRowCountByWidth = new Map();
			entry.stableFrozen = false;
			if (entry.mode === "appendOnly") {
				(entry.component as Component & AppendOnlyTranscriptBlock).resetTranscriptStableRows?.();
			}
		}
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) {
			for (const entry of this.#entries) entry.state = "settled";
			this.#frontier = 0;
		}
	}

	/** Whether a transient block may be discarded without leaving tape history. */
	canRemoveBlock(component: Component): boolean {
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return false;
		const entry = this.#entries[index]!;
		if (entry.state === "committed" || entry.emitted > 0 || entry.borrowed) return false;
		if (this.#offered?.kind === "commit" && index < this.#offered.end) return false;
		if (this.#offered?.kind === "append" && index === this.#offered.entry) return false;
		return true;
	}

	/**
	 * Rows currently held by blocks whose height is reversible. The frame budget
	 * grows by exactly this count so a temporary insertion never retires
	 * transcript rows it will hand back when it collapses or disappears.
	 */
	transientRowCount(width: number): number {
		let count = 0;
		for (const block of this.transientBlocks(width)) count += block.rows;
		return count;
	}

	/**
	 * Open a composition: every entry rendered until {@link endPaint} is
	 * memoized for this exact frame, so the history offer, transient
	 * measurement, row count and live viewport walks of one paint render each
	 * block once. Outside a paint every call renders fresh.
	 */
	beginPaint(frame: AnimationFrame): void {
		// A new paint supersedes any earlier one, including a paint whose walk
		// threw before reaching endPaint: its memo keyed a different frame object
		// and can never be hit again, so no stale rows can leak across paints.
		this.#paintFrame = frame;
	}

	endPaint(): void {
		this.#paintFrame = undefined;
	}

	/**
	 * Per-block breakdown of {@link transientRowCount}, for render debugging:
	 * which live block currently holds back how many rows. When a physical
	 * allocation is supplied, mutable blocks are first shaped for that same
	 * frame so the reservation cannot retain their prior viewport height.
	 */
	transientBlocks(
		width: number,
		allocation?: number,
		frame?: AnimationFrame,
	): readonly { label: string; rows: number }[] {
		this.#syncEntries();
		const blocks: { label: string; rows: number }[] = [];
		for (const entry of this.#entries) {
			if (entry.state === "committed" || entry.emitted > 0) continue;
			// A finished block that still holds a peak is presented at that height
			// until it leaves the live region, so the reservation must count it
			// too, or the planner would release rows the viewport still shows.
			if (!isTransient(entry.component) && entry.peakLiveRows === undefined) continue;
			if (
				allocation !== undefined &&
				frame !== undefined &&
				entry.state === "active" &&
				(entry.component as TranscriptPresentationTarget).setTranscriptAllocation !== undefined
			) {
				this.#setAllocation(entry, allocation, frame);
			}
			// Measure at the same held height the viewport will present, or the
			// reservation would swing with the raw render while the card does not.
			const rows = this.#holdPeakHeight(entry, width, this.#renderEntry(entry, width, frame), 0).length;
			if (rows > 0) blocks.push({ label: entry.component.constructor.name, rows });
		}
		return blocks;
	}
	/**
	 * Insert a finalized block just above the live region — before the first
	 * still-mutating block (mid-stream assistant reply, pending tool). Settled
	 * blocks appended *below* a mutating sibling repaint with every streaming
	 * frame and can never retire in order (#4806); mounted in the leading
	 * finalized run they retire exactly once. Appends when nothing is live.
	 */
	insertSettledBlock(component: Component): void {
		for (const child of this.children) {
			if (!isFinalized(child)) {
				this.insertChildBefore(component, child);
				this.#syncEntries();
				return;
			}
		}
		this.addChild(component);
	}

	/** Whether no rows of this component have entered immutable history. */
	isBlockUncommitted(component: Component): boolean {
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		if (index < 0) return true;
		const entry = this.#entries[index]!;
		if (entry.state === "committed" || entry.emitted > 0 || entry.borrowed) return false;
		if (this.#offered?.kind === "commit" && index < this.#offered.end) return false;
		if (this.#offered?.kind === "append" && index === this.#offered.entry) return false;
		return true;
	}

	/**
	 * Whether `component` still sits in the live (repaintable) region: at or
	 * after the retirement frontier. Self-animating finalized blocks poll this
	 * to settle on static bytes once their rows become retirement-eligible.
	 */
	isBlockInLiveRegion(component: Component): boolean {
		this.#syncEntries();
		const index = this.#entries.findIndex(entry => entry.component === component);
		return index >= 0 && index >= this.#frontier;
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

	/** Whether visible active capacity and live-block memory permit another admission. */
	canAdmit(rows: number): boolean {
		const active = this.#entries.filter(entry => entry.state === "active").length;
		return Math.max(0, Math.trunc(rows)) > active && this.#liveCount() < MAX_LIVE_BLOCKS;
	}

	/** Prepares one atomic replay of the committed ledger and an emitted active-head prefix. */
	beginReplay(): void {
		this.#syncEntries();
		if (this.#offered !== undefined) {
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
	}

	/** Total rows the live, un-emitted tail occupies at `width`. */
	liveRowCount(width: number): number {
		this.#enterFrame(width);
		let total = 0;
		for (const { entry, index } of this.#liveEntries()) {
			this.#setAllocation(entry, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = this.#renderEntry(entry, width);
			const block = rendered.slice(this.#projectedEmittedRowCount(entry, index, width));
			if (block.length > 0) total += block.length + (total > 0 ? 1 : 0);
		}
		return total;
	}

	/** The retained live frame is distinct from the terminal's physical projection. */
	get liveViewport(): LiveViewportFrame {
		return this.#liveViewport;
	}

	renderLiveViewport(width: number, physicalRows: number, frame: AnimationFrame): LiveViewportFrame {
		const height = Math.max(0, Math.trunc(physicalRows));
		const rows = this.#renderViewport(width, height, frame);
		let borrowableRows = rows.length;
		for (const { entry } of this.#liveEntries()) {
			if (
				entry.state === "active" &&
				(entry.component as TranscriptPresentationTarget).setTranscriptAllocation !== undefined &&
				entry.viewportStart !== undefined
			) {
				borrowableRows = Math.min(borrowableRows, entry.viewportStart);
				break;
			}
		}
		this.#liveViewport = { rows, capacity: height * 2, physicalRows: height, borrowableRows };
		return this.#liveViewport;
	}

	/** Complete semantic live rows; physical clipping belongs to the frame renderer. */
	renderViewport(width: number, _rows: number, frame: AnimationFrame): readonly string[] {
		return this.#renderViewport(width, Number.MAX_SAFE_INTEGER, frame);
	}

	#renderViewport(width: number, rows: number, frame: AnimationFrame): readonly string[] {
		this.#lastFrame = frame;
		this.#enterFrame(width);
		const output: string[] = [];
		this.#lastViewportSpans = [];
		let previous: TranscriptEntry | undefined;
		for (const { entry, index } of this.#liveEntries()) {
			entry.viewportStart = undefined;
			const mutableTool =
				entry.state === "active" &&
				(entry.component as TranscriptPresentationTarget).setTranscriptAllocation !== undefined;
			this.#setAllocation(entry, mutableTool ? rows : Number.MAX_SAFE_INTEGER, frame);
			// Only hide rows the terminal still owns verbatim. A card that reshaped
			// after lending its head (status, spinner, partial result, width change)
			// no longer matches those bytes, and slicing them would bite rows out of
			// a card that fits the viewport.
			const projected = this.#projectedEmittedRowCount(entry, index, width);
			const offset =
				projected > 0 && !this.#borrowedPrefixMatches(entry, this.#renderEntry(entry, width, frame))
					? 0
					: projected;
			const rendered = this.#holdPeakHeight(entry, width, this.#renderEntry(entry, width, frame), offset);
			if (rendered.length === 0) continue;
			if (output.length > 0) {
				output.push("");
				if (previous) previous.viewportExtent = (previous.viewportExtent ?? 0) + 1;
			}
			entry.viewportStart = output.length;
			entry.viewportOffset = offset;
			entry.viewportExtent = rendered.length;
			this.#lastViewportSpans.push({
				component: entry.component,
				start: output.length,
				end: output.length + rendered.length,
			});
			previous = entry;
			output.push(...rendered);
		}
		return output;
	}

	/** Track immutable borrowed rows without advancing the canonical emission ledger. */
	setBorrowedViewportRows(rows: number): void {
		for (const { entry } of this.#liveEntries()) {
			const count =
				entry.viewportStart === undefined
					? 0
					: Math.max(0, Math.min(rows - entry.viewportStart, entry.viewportExtent ?? 0));
			const previous = entry.borrowedRows;
			const previousOffset = entry.viewportOffset;
			entry.borrowed = count > 0;
			entry.borrowedEnd = count > 0 ? (entry.viewportOffset ?? 0) + count : 0;
			entry.borrowedRows =
				count > 0 && entry.viewportStart !== undefined
					? this.#liveViewport.rows.slice(entry.viewportStart, entry.viewportStart + count)
					: undefined;
			if (
				entry.mode === "appendOnly" &&
				previous !== undefined &&
				entry.borrowedRows !== undefined &&
				previousOffset === entry.viewportOffset
			) {
				const overlap = Math.min(previous.length, entry.borrowedRows.length);
				for (let index = 0; index < overlap; index++) {
					if (previous[index] !== entry.borrowedRows[index]) {
						entry.historyDirty = true;
						break;
					}
				}
			}
		}
	}

	/** Leading current viewport rows still owned by previously borrowed entries. */
	borrowedViewportRowCount(): number {
		let count = 0;
		for (const { entry } of this.#liveEntries()) {
			if (entry.viewportStart === undefined) continue;
			if (entry.viewportStart !== count || !entry.borrowed) break;
			const extent = entry.viewportExtent ?? 0;
			const retained = Math.max(0, Math.min((entry.borrowedEnd ?? 0) - (entry.viewportOffset ?? 0), extent));
			count += retained;
			if (retained < extent) break;
		}
		return count;
	}

	/** Block spans of the last `renderViewport` output, in output coordinates. Empty when the tail is empty. */
	getLastViewportSpans(): readonly TranscriptViewportSpan[] {
		return this.#lastViewportSpans;
	}

	/** Offers stable-head emission or the shortest finalized prefix needed under pressure. */
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
		const rows = this.#renderReplay(width);
		this.#replayPending = false;
		// Even an empty ledger needs an acknowledged replay transaction: TUI
		// uses its completion to release a destructive reset and restore the
		// mutable viewport after a damaged popup.
		const batch: HistoryBatch = { id: this.#nextBatchId++, rows, kind: "replay" };
		this.#offered = { batch, kind: "replay" };
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
			rows = after.slice(before.length);
		} else if (offered.kind === "commit") {
			rows = this.#renderRange(this.#frontier, offered.end, width, true);
		} else {
			rows = this.#renderReplay(width);
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
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const rendered: (readonly string[])[] = new Array(live.length);
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const heights: number[] = new Array(live.length);
		let total = 0;
		let visible = 0;
		for (let index = 0; index < live.length; index++) {
			const candidate = live[index]!;
			this.#setAllocation(candidate.entry, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const renderedEntry = this.#renderEntry(candidate.entry, width);
			const rows = renderedEntry.slice(
				this.#renderStablePrefix(candidate.entry, candidate.entry.emitted, width).length,
			);
			rendered[index] = rows;
			heights[index] = rows.length;
			if (rows.length > 0) total += rows.length + (visible++ > 0 ? 1 : 0);
		}
		let requiredEnd = this.#frontier;
		for (let cursor = this.#frontier; cursor < this.#entries.length; cursor++) {
			const entry = this.#entries[cursor]!;
			if (entry.state !== "settled") break;
			if (isTransient(entry.component)) break;
			// Rows the terminal borrowed into native scrollback are immutable. A
			// settled card whose current render diverges from those rows would be
			// re-emitted from the first changed row (the documented stale seam),
			// which under first-frame retirement shows up as a duplicated card the
			// moment a tool finishes. Leave such a block to the ordinary pressure
			// policy, which only retires once its borrowed prefix reconciles.
			if (entry.borrowed && !this.#borrowedPrefixMatches(entry, rendered[cursor - this.#frontier])) break;
			if ((entry.component as Component & FinalizableBlock).commitToHistoryOnFinalize === true)
				requiredEnd = cursor + 1;
		}
		const overflowing = total > room || this.#liveCount() >= MAX_LIVE_BLOCKS;
		if (policy === "pressure" && !overflowing && requiredEnd === this.#frontier) {
			this.#pinnedFrontier = undefined;
			return undefined;
		}

		const head = this.#entries[this.#frontier];
		const settledRows = Math.max(
			0,
			Math.trunc(
				(head?.component as (Component & FinalizableBlock) | undefined)?.getTranscriptBlockSettledRows?.() ?? 0,
			),
		);
		if (policy === "pressure" && total > room && head !== undefined && settledRows > head.emitted) {
			const raw = head.component.render(width);
			let leadingBlankRows = 0;
			while (leadingBlankRows < raw.length && isPlainBlank(raw[leadingBlankRows]!)) leadingBlankRows++;
			const renderedHead = this.#renderEntry(head, width);
			const emittedEnd = Math.min(
				renderedHead.length,
				Math.max(0, settledRows - leadingBlankRows),
				head.emitted + total - room,
			);
			if (emittedEnd > head.emitted) {
				const batch: HistoryBatch = {
					id: this.#nextBatchId++,
					rows: renderedHead.slice(head.emitted, emittedEnd),
					kind: "append",
				};
				this.#offered = { batch, kind: "append", entry: this.#frontier, emittedEnd };
				this.#pinnedFrontier = undefined;
				return batch;
			}
		}
		if (
			policy === "pressure" &&
			total > room &&
			head?.mode === "appendOnly" &&
			!head.stableFrozen &&
			head.state !== "committed" &&
			head.emitted < head.stableRows.length
		) {
			// Emit as many finished rows as the overflow needs, in one batch. A
			// fast stream adds finished rows quicker than one per pressure cycle,
			// and the live region has to fall back under `room` to stay readable:
			// rows left behind here are rows dropped from the top of the viewport.
			const overflow = total - room;
			const before = this.#renderStablePrefix(head, head.emitted, width);
			let emittedEnd = head.emitted;
			let rows: readonly string[] = EMPTY_ROWS;
			while (emittedEnd < head.stableRows.length && rows.length < overflow) {
				const after = this.#renderStablePrefix(head, emittedEnd + 1, width);
				if (!isRowPrefix(before, after) || after.length === before.length) {
					if (emittedEnd === head.emitted) {
						this.#freezeStableRows(head, EMPTY_ROWS, "semantic row render added no suffix");
					}
					break;
				}
				rows = after.slice(before.length);
				emittedEnd += 1;
			}
			if (emittedEnd > head.emitted) {
				const batch: HistoryBatch = {
					id: this.#nextBatchId++,
					rows,
					kind: "append",
					divergent: head.historyDirty === true,
				};
				this.#offered = { batch, kind: "append", entry: this.#frontier, emittedEnd };
				this.#pinnedFrontier = undefined;
				return batch;
			}
		}

		let end = this.#frontier;
		let freed = 0;
		let index = 0;
		while (end < this.#entries.length && this.#entries[end]!.state === "settled") {
			if (
				end >= requiredEnd &&
				policy === "pressure" &&
				total - freed <= room &&
				this.#liveCount() - (end - this.#frontier) < MAX_LIVE_BLOCKS
			)
				break;
			// A finalized block can still occupy most of the physical screen.
			// Do not retire its visible tail merely because its first rows overflow.
			if (
				policy === "pressure" &&
				end >= requiredEnd &&
				!this.#entries[end]!.borrowed &&
				room > 0 &&
				total - freed - (heights[index]! > 0 ? heights[index]! + 1 : 0) < room &&
				this.#liveCount() - (end - this.#frontier) < MAX_LIVE_BLOCKS
			)
				break;
			freed += heights[index]! > 0 ? heights[index]! + 1 : 0;
			end++;
			index++;
		}
		if (end === this.#frontier) {
			if (policy === "pressure") this.#notePinnedFrontier();
			return undefined;
		}
		this.#pinnedFrontier = undefined;
		const batch: HistoryBatch = {
			id: this.#nextBatchId++,
			rows: this.#renderRange(this.#frontier, end, width, true),
			kind: "append",
			divergent: this.#hasDivergentBorrowedStream(this.#frontier, end, width),
		};
		this.#offered = { batch, end, kind: "commit" };
		return batch;
	}

	/** Acknowledges exactly the most recently offered append, commit, or replay transaction. */
	acknowledgeFinalizedBatch(id: number): void {
		const offered = this.#offered;
		if (offered === undefined || offered.batch.id !== id) return;
		if (offered.kind === "append") {
			const entry = this.#entries[offered.entry];
			if (entry === undefined || offered.entry !== this.#frontier || offered.emittedEnd <= entry.emitted) return;
			entry.emitted = offered.emittedEnd;
			// A divergent batch is followed by one ledger replay that rewrites it.
			entry.historyDirty = false;
		} else if (offered.kind === "commit") {
			for (let index = this.#frontier; index < offered.end; index++) {
				const entry = this.#entries[index]!;
				entry.state = "committed";
				entry.emitted = 0;
				// Committed rows are durable history, not borrowed viewport residue:
				// a later replay must re-render the whole block, not re-slice it.
				entry.borrowed = false;
				entry.borrowedEnd = 0;
				entry.borrowedRows = undefined;
				entry.historyDirty = false;
			}
			this.#frontier = offered.end;
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
		this.#syncEntries();
		const cap = Math.max(0, Math.trunc(maxRows));
		if (cap === 0) return EMPTY_ROWS;
		const rows: string[] = [];
		for (let index = this.#entries.length - 1; index >= 0; index--) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = trimBlankEdges(entry.component.render(width));
			if (block.length === 0) continue;
			if (rows.length > 0) rows.unshift("");
			rows.unshift(...block);
			if (rows.length >= cap) break;
		}
		return rows.length > cap ? rows.slice(rows.length - cap) : rows;
	}

	/** Full semantic render used by exports and non-terminal commands. */
	override render(width: number): readonly string[] {
		this.#syncEntries();
		this.#childStartRows.clear();
		const rows: string[] = [];
		for (const entry of this.#entries) {
			this.#setAllocation(entry, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const block = this.#renderEntry(entry, width);
			if (block.length === 0) continue;
			if (rows.length > 0) rows.push("");
			this.#childStartRows.set(entry.component, rows.length);
			rows.push(...block);
		}
		return rows;
	}

	/** Rendered row where a child's block begins in the last full render() (transcript deep-links). */
	getChildStartRow(child: Component): number | undefined {
		return this.#childStartRows.get(child);
	}

	/**
	 * Render one entry. With `frame` supplied the result is memoized for that
	 * exact paint, so the transient-measurement and live-viewport walks of one
	 * composition share a single render per block. Without a frame - direct
	 * `render()`, batch peeks, row counts - the entry is rendered fresh, which
	 * is both correct (content may have changed since any paint) and free (those
	 * paths visit each entry once).
	 */
	#renderEntry(entry: TranscriptEntry, width: number, explicitFrame?: AnimationFrame): readonly string[] {
		const frame = explicitFrame ?? this.#paintFrame;
		if (frame === undefined) return this.#renderEntryUncached(entry, width);
		const memo = entry.frameMemo;
		if (memo !== undefined && memo.frame === frame && memo.width === width && memo.allocation === entry.allocation) {
			return memo.rows;
		}
		const rendered = this.#renderEntryUncached(entry, width);
		entry.frameMemo = { frame, width, allocation: entry.allocation, rows: rendered };
		return rendered;
	}

	/**
	 * A live block never shrinks once it has grown. Streaming output, a tool
	 * that clears a status section, a failing edit that collapses to an error
	 * card: each used to change the card's height, and every change moved the
	 * whole live region and re-diffed the frame. The block is held at the
	 * tallest height it reached at this width for as long as it is live,
	 * finished or not; leaving the live region releases it.
	 *
	 * Presentation only: applied to the live suffix AFTER the emitted stable
	 * prefix is sliced off, so pad rows never enter stable rows, a history
	 * batch or a replay, and never scroll into native scrollback as a band.
	 * Keyed on width so a narrow reflow cannot pin excess padding after the
	 * terminal widens.
	 */
	#holdPeakHeight(entry: TranscriptEntry, width: number, whole: readonly string[], offset: number): readonly string[] {
		// Runs for every live entry on every walk of every frame, so it must not
		// copy unless it has to: slice only when there is an emitted prefix, and
		// build a padded array only when the block is actually short of its peak.
		const liveLength = whole.length - offset;
		// Held while the card is running: that is when it grows and contracts
		// frame to frame. A finished card is released immediately - its final
		// collapse (a write card folding to its preview) is one contraction,
		// not an oscillation, and holding it would leave the pad rows on screen
		// as a black band under the card until history commits it.
		// Scoped to blocks that emit no stable prefix (mutable tool cards, the
		// class that grew and contracted): an append-only block retires rows to
		// history mid-stream by design, and the planner's transient measurement
		// excludes emitting blocks, so holding them would desynchronize the two.
		if (entry.state !== "active" || isFinalized(entry.component) || entry.emitted > 0 || liveLength <= 0) {
			entry.peakLiveRows = undefined;
			return offset === 0 ? whole : whole.slice(offset);
		}
		// The peak is the block's WHOLE height. Rows leaving the live suffix
		// because they were emitted to history are not a contraction of the
		// card, so the pad is whatever the whole block is short of its peak.
		const previous = entry.peakLiveRows;
		const peak =
			previous !== undefined && previous.width === width ? Math.max(previous.rows, whole.length) : whole.length;
		if (previous === undefined || previous.width !== width || previous.rows !== peak) {
			entry.peakLiveRows = { width, rows: peak };
		}
		// Content never lowers the card, but the screen can: when the live budget
		// shrinks (the editor grew), a mutable card is squeezed to its allocation
		// so the frame still fits, and holding the old peak would overflow it.
		const target = Number.isFinite(entry.allocation) ? Math.min(peak, Math.max(0, entry.allocation)) : peak;
		if (whole.length >= target) return offset === 0 ? whole : whole.slice(offset);
		const padded: string[] = new Array(liveLength + (target - whole.length));
		for (let i = 0; i < liveLength; i++) padded[i] = whole[offset + i]!;
		for (let i = liveLength; i < padded.length; i++) padded[i] = "";
		return padded;
	}

	#renderEntryUncached(entry: TranscriptEntry, width: number): readonly string[] {
		const rendered = trimBlankEdges(entry.component.render(width));
		if (entry.mode === "mutable" || entry.stableFrozen) return rendered;
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
		if (!isRowPrefix(stableRendered, rendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows no longer render as a prefix of the block");
		}
		const priorRender = entry.renderedStableByWidth.get(width);
		if (priorRender && !isRowPrefix(priorRender, stableRendered)) {
			return this.#freezeStableRows(entry, rendered, "stable rows changed within a width epoch");
		}
		entry.stableRows = published;
		// Slice only when the rendered rows actually changed: same length
		// plus prefix-equality in both directions means byte-identical, so
		// the stored array can be reused (callers only slice/read it).
		const priorRows = entry.renderedStableByWidth.get(width);
		if (
			priorRows === undefined ||
			priorRows.length !== stableRendered.length ||
			!isRowPrefix(priorRows, stableRendered)
		) {
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
		if (entry.mode === "mutable") return this.#renderEntry(entry, width).slice(0, count);
		const appendOnly = entry.component as Component & AppendOnlyTranscriptBlock;
		return appendOnly.renderTranscriptStableRows(Math.min(count, entry.stableRows.length), width);
	}

	/**
	 * Length-only variant of `#renderStablePrefix`: answers the projected
	 * emitted row count without re-rendering the prefix. The container only
	 * needs the length for slicing; the render call it replaced existed
	 * purely to read `.length` off the result.
	 */
	#projectedEmittedRowCount(entry: TranscriptEntry, index: number, width: number): number {
		const offered = this.#offered;
		const count = offered?.kind === "append" && offered.entry === index ? offered.emittedEnd : entry.emitted;
		if (count === 0) return 0;
		const perCount = entry.stableRowCountByWidth.get(width);
		const memo = perCount?.get(Math.min(count, entry.stableRows.length));
		if (memo !== undefined) return memo;
		return this.#renderStablePrefix(entry, count, width).length;
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
		logger.warn("Transcript retirement pinned by unfinalized frontier block", {
			component: entry.component.constructor.name,
			state: entry.state,
			mode: entry.mode,
			liveBlocks: this.#liveCount(),
		});
	}

	/**
	 * Whether every row the terminal borrowed from `entry` still renders
	 * byte-identical. A borrow can extend one row past the block: the viewport
	 * attributes the blank separator that follows a block to that block's
	 * extent, while `render` never emits it. Those trailing blanks are frame
	 * separators, not card content, so they match by construction — comparing
	 * them against `undefined` would mark every fully borrowed block divergent
	 * and permanently pin both the emitted-offset reuse and retirement.
	 */
	#borrowedPrefixMatches(entry: TranscriptEntry, rendered: readonly string[] | undefined): boolean {
		const borrowedRows = entry.borrowedRows;
		if (borrowedRows === undefined || borrowedRows.length === 0) return true;
		if (rendered === undefined) return false;
		const offset = entry.viewportOffset ?? 0;
		for (let index = 0; index < borrowedRows.length; index++) {
			const row = rendered[offset + index];
			if (row === undefined) {
				if (borrowedRows[index] !== "") return false;
				continue;
			}
			if (row !== borrowedRows[index]) return false;
		}
		return true;
	}

	/**
	 * Whether a streamed (append-only) block in `[start, end)` lent rows to
	 * native history that its finalized render no longer reproduces: either an
	 * earlier frame re-rendered them (`historyDirty`), or the block settles in
	 * this very frame (a markdown fence closing as the reply ends). Mutable tool
	 * cards keep their stale borrowed copy by design and never qualify.
	 */
	#hasDivergentBorrowedStream(start: number, end: number, width: number): boolean {
		for (let index = start; index < end; index++) {
			const entry = this.#entries[index]!;
			if (entry.mode !== "appendOnly") continue;
			if (entry.historyDirty === true) return true;
			if (entry.borrowed && !this.#borrowedPrefixMatches(entry, this.#renderEntry(entry, width))) return true;
		}
		return false;
	}

	#renderRange(start: number, end: number, width: number, trailingBlank: boolean): readonly string[] {
		const rows: string[] = [];
		// A block already fully in scrollback (borrowed or emitted) contributes no
		// rows, but the blank that separates it from the next block is only in
		// scrollback when the terminal borrowed that row too. Otherwise the
		// separator is still owed, and dropping it glues the next block onto the
		// previous card — the seam bites a row out of the earlier viewport.
		let separatorOwed = false;
		for (let index = start; index < end; index++) {
			const entry = this.#entries[index]!;
			this.#setAllocation(entry, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			// Only the range head is sliced by its emitted stable prefix; every other
			// entry renders whole, so the append-only verification pass (a second
			// full render of the block's stable prefix) is skipped for them. This
			// keeps a complete-ledger replay at one render per block.
			const rendered =
				index === start ? this.#renderEntry(entry, width) : trimBlankEdges(entry.component.render(width));
			let skip = index === start ? this.#renderStablePrefix(entry, entry.emitted, width).length : 0;
			let separatorBorrowed = false;
			// Rows the terminal already borrowed into native scrollback are immutable
			// history, whether or not the card still renders them byte-identical.
			// Re-emitting a changed row cannot correct it — history rows land at the
			// physical boundary, below every row borrowed since, so the "fix" shows
			// up as a stray footer or a whole duplicated card under later blocks
			// (parallel streaming previews diverge on every frame). Keep the stale
			// borrowed copy and emit only what was never borrowed.
			const borrowedRows = entry.borrowedRows;
			if (borrowedRows !== undefined && borrowedRows.length > 0) {
				// `borrowedEnd` is the absolute row fixed when the rows were lent;
				// `viewportOffset` is rewritten by every later frame.
				const borrowedEnd = entry.borrowedEnd ?? (entry.viewportOffset ?? 0) + borrowedRows.length;
				skip = Math.max(skip, Math.min(rendered.length, borrowedEnd));
				separatorBorrowed = borrowedEnd > rendered.length;
			}
			const block = rendered.slice(skip);
			if (block.length === 0) {
				if (rendered.length > 0) separatorOwed = !separatorBorrowed;
				continue;
			}
			if (rows.length > 0 || separatorOwed) rows.push("");
			separatorOwed = false;
			rows.push(...block);
		}
		if (trailingBlank && (rows.length > 0 || separatorOwed)) rows.push("");
		return rows;
	}

	#renderReplay(width: number): readonly string[] {
		const rows = Array.from(this.#renderRange(0, this.#frontier, width, true));
		const head = this.#entries[this.#frontier];
		if (head !== undefined && head.emitted > 0) {
			this.#setAllocation(head, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			this.#renderEntry(head, width);
			rows.push(...this.#renderStablePrefix(head, head.emitted, width));
		}
		return rows;
	}

	#completeFullyEmittedHeads(width: number): void {
		while (this.#frontier < this.#entries.length) {
			const entry = this.#entries[this.#frontier]!;
			if (entry.mode !== "appendOnly" || entry.state !== "settled") return;
			this.#setAllocation(entry, Number.MAX_SAFE_INTEGER, this.#lastFrame);
			const rendered = this.#renderEntry(entry, width);
			if (entry.emitted !== entry.stableRows.length) return;
			if (this.#renderStablePrefix(entry, entry.emitted, width).length !== rendered.length) return;
			entry.state = "committed";
			entry.emitted = 0;
			this.#frontier++;
		}
	}

	#startReplay(): void {
		this.#replayPending = true;
		this.#replayRequested = false;
	}

	#setAllocation(entry: TranscriptEntry, rows: number, frame: AnimationFrame): void {
		entry.allocation = rows;
		(entry.component as Component & TranscriptPresentationTarget).setTranscriptAllocation?.(rows, frame);
	}

	#settleFinalized(): void {
		for (let index = this.#frontier; index < this.#entries.length; index++) {
			const entry = this.#entries[index]!;
			if (entry.state === "active" && isFinalized(entry.component)) entry.state = "settled";
		}
	}

	#liveEntries(): Array<{ entry: TranscriptEntry; index: number }> {
		const start = this.#offered?.kind === "commit" ? this.#offered.end : this.#frontier;
		const live: Array<{ entry: TranscriptEntry; index: number }> = [];
		for (let index = start; index < this.#entries.length; index++) live.push({ entry: this.#entries[index]!, index });
		return live;
	}

	#liveCount(): number {
		return this.#entries.length - this.#frontier;
	}

	#syncEntries(): void {
		if (
			this.#entries.length === this.children.length &&
			this.#entries.every((entry, index) => entry.component === this.children[index])
		)
			return;
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
					allocation: Number.POSITIVE_INFINITY,
				},
		);
		this.#frontier = this.#entries.findIndex(entry => entry.state !== "committed");
		if (this.#frontier < 0) this.#frontier = this.#entries.length;
	}
}

/** Groups sibling rows into one conservative mutable semantic transcript block. */
export class TranscriptBlock extends Container {}
