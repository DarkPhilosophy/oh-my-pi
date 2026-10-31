import { getComposerStyle } from "../components/composer/registry";
import { Spacer } from "../components/spacer";
import type { StatusLineComponent } from "../status-line/component";
import { compositeLineAt } from "../render/composite";
import { type ExtensionLinkLabel, extensionLinkLabels, linkHintTags } from "../render/extension-links";
import type { StatusLineSession } from "../status-line/host";
import { createStartupStatusLine, type StatusLineStartupData } from "../status-line/startup";
import { isInsideTerminalMultiplexer } from "../terminal-multiplexer";
import { ProcessTerminal, type Terminal } from "../terminal";
import {
	type Component,
	Container,
	type ResizeScrollbackMode,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	type TerminalFrameSegment,
	TUI,
	type TUIOptions,
	type ViewportSize,
} from "../tui";
import { wrapLiteralLine } from "../utils";
import type { NativeChild, NativeSurface, NativeSurfaceProvider } from "../native/node";
import { sameItems } from "../native/memo";
import { postmortem } from "@oh-my-pi/pi-utils";
import { CustomEditor } from "./custom-editor";
import type { WordCompletionMethod } from "./word-completion";
import { type AnimationFrame, TranscriptContainer } from "../chrome/transcript-container";
import { WelcomeComponent, type RecentSession, type LspServerInfo } from "./welcome";
import { ensureThemeSync, getEditorTheme, theme } from "../theme/theme";

const DOUBLE_INTERRUPT_MS = 500;

/** Live settings that affect the composer before and after session adoption. */
export interface ComposerPreferences {
	readonly quiet: boolean;
	readonly composerShape: string;
	readonly showHardwareCursor: boolean;
	readonly maxInlineImages: number;
	readonly resizeScrollback: ResizeScrollbackMode;
	readonly imeSafeCursor: boolean;
	readonly autocompleteMaxVisible: number;
	readonly spellingTypoDetection: boolean;
	readonly spellingAutocomplete: WordCompletionMethod;
	readonly spellingAutocorrect: boolean;
}

/** Settings-schema-compatible defaults used when constructing a dependency-free composer. */
export const COMPOSER_DEFAULTS: ComposerPreferences = {
	quiet: false,
	composerShape: "band",
	showHardwareCursor: true,
	maxInlineImages: 8,
	resizeScrollback: "rebuild",
	imeSafeCursor: false,
	autocompleteMaxVisible: 10,
	spellingTypoDetection: true,
	spellingAutocomplete: "auto",
	spellingAutocorrect: false,
};

/** Welcome data that can be supplied initially or patched as startup resolves it. */
export interface ComposerWelcomeUpdate {
	readonly version?: string;
	readonly modelName?: string;
	readonly providerName?: string;
	readonly recentSessions?: readonly RecentSession[];
	/** Detected project servers; `null` means LSP is disabled and hides the welcome section. */
	readonly lspServers?: readonly LspServerInfo[] | null;
}

/**
 * Status-bar inputs persisted by the last session. The first frame renders
 * them through a startup {@link StatusLineComponent} at the live width until
 * the session-aware status line attaches.
 */
export interface ComposerStatusCache {
	/** ANSI wrapper of the editor border when persisted (session accent or thinking color). */
	readonly borderColor?: {
		readonly prefix: string;
		readonly suffix: string;
	};
	readonly statusLine: StatusLineStartupData;
}

/** Optional dependencies and initial state for a standalone composer. */
export interface ComposerOptions {
	readonly terminal?: Terminal;
	/** Extra TUI construction options (render scheduler injection for tests and `omp render`). */
	readonly tuiOptions?: TUIOptions;
	readonly preferences?: Partial<ComposerPreferences>;
	readonly welcome?: ComposerWelcomeUpdate;
	readonly status?: ComposerStatusCache;
	readonly exit?: (code: number) => void;
	readonly now?: () => number;
}

/** How {@link Composer.setRuntimeChildren} lays out the roots below the transcript. */
export interface RuntimeChildrenOptions {
	/**
	 * Dock order on a TSP terminal (no status strip; the composer carries its
	 * facts): the native dock stacks HUD pills, the working row and queued messages over
	 * the composer in its own order, and may add describe-only roots. Defaults
	 * to the roots below the transcript in render order.
	 */
	readonly nativeDock?: readonly Component[];
}

/** Controls the first terminal paint for a composer that does not already own the terminal. */
export interface ComposerStartOptions {
	readonly clearScrollback?: boolean;
	readonly playWelcomeIntro?: boolean;
	/**
	 * Paint without owning stdin: the tty keeps cooked-mode echo/editing so
	 * typing stays visible while startup module loading blocks the event loop.
	 * {@link Composer.enableInput} later switches to raw input and replays the
	 * kernel-buffered keystrokes into the editor.
	 */
	readonly deferInput?: boolean;
}

/**
 * Mount slot below the editor: the startup status line, then the session-aware
 * one. ANSI only: a TSP terminal has no status strip, the composer carries the
 * status line's facts ({@link StatusLineComponent.describeComposerFacts}).
 */
class StatusHost implements Component {
	#component: Component | undefined;

	setComponent(component: Component): void {
		this.#component = component;
	}

	render(width: number): readonly string[] {
		return this.#component?.render(width) ?? [];
	}
}

/** One click target's row span within the mutable viewport (half-open `[start, end)`). */
export interface ViewportClickSpan {
	start: number;
	end: number;
	/** Candidate subagent ids for a span-local row. */
	candidates: (local: number) => string[];
}

/**
 * Row-level click target: maps rendered rows to subagent ids. Implemented by
 * the subagent HUD, whose rows are fixed 1:1 with visible sessions.
 */
export interface ViewportClickRowTarget {
	getClickAgentAtRow(row: number): string | undefined;
}

/**
 * Candidates under a mutable-viewport line: the first span containing it.
 * Pure seam for tests; the caller intersects with the live registry, which
 * decides focusability and recency.
 */
export function routeViewportClick(spans: readonly ViewportClickSpan[], index: number): string[] {
	if (!Number.isInteger(index) || index < 0) return [];
	for (const span of spans) {
		if (index < span.start || index >= span.end) continue;
		return span.candidates(index - span.start);
	}
	return [];
}

/** An extension link label drawn on a mutable-viewport line: what a click or hint tag lands on. */
export interface ViewportLink {
	readonly url: string;
	/** Mutable-viewport line the label is drawn on. */
	readonly row: number;
	/** First cell of the label's part on that line. */
	readonly start: number;
}

/** An extension link label tagged for picking by keyboard in link-hint mode. */
interface ViewportLinkHint {
	readonly tag: string;
	readonly link: ViewportLink;
}

/**
 * Called once when link-hint mode ends; `reason` is `"crowded"` when a row held more links than
 * their tags could fit side by side, so no tags were drawn.
 */
export type LinkHintsEnd = (reason?: "crowded") => void;

/**
 * The extension link labels drawn on `rows`, top to bottom, a wrapped label once at its first row:
 * a row's first label continues the previous row's last label when that has the same marker id
 * and ends its row.
 */
function viewportLinkTargets(rows: readonly string[]): ViewportLink[] {
	const targets: ViewportLink[] = [];
	let previous: ExtensionLinkLabel | undefined;
	for (let row = 0; row < rows.length; row++) {
		const labels = extensionLinkLabels(rows[row]!);
		for (const [index, label] of labels.entries()) {
			if (index === 0 && previous?.endsRow && previous.id === label.id) continue;
			targets.push({ url: label.url, row, start: label.start });
		}
		previous = labels.at(-1);
	}
	return targets;
}

/**
 * Nested background opens inside a hovered row. The band wraps the line, so a
 * surviving nested open would paint over it for every cell it covers; the
 * matching closes stay and become band resumes via bgFill.
 */
const NESTED_BG_OPEN_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[(?:4[0-7]|10[0-7]|48;[0-9;]*)m`, "g");

/**
 * Candidate resolver for a row-level click target, if the component is one.
 * Shared by root and nested-child hit-testing so both stay in lockstep.
 */
function rowTargetCandidates(target: Component): ((local: number) => string[]) | undefined {
	const rowTarget = target as Partial<ViewportClickRowTarget>;
	if (typeof rowTarget.getClickAgentAtRow !== "function") return undefined;
	return (local: number) => {
		const id = rowTarget.getClickAgentAtRow?.(local);
		return id === undefined ? [] : [id];
	};
}

/**
 * Canonical interactive composer, usable before session/settings exist and updatable in place.
 * It owns the terminal, welcome header, and editor; InteractiveMode later supplies authoritative
 * data and mounts the session-aware runtime children without replacing the visible header.
 */
export class Composer implements TerminalFrameProvider, NativeSurfaceProvider {
	readonly ui: TUI;
	#editor: CustomEditor;
	readonly #header = new Container();
	/** Composer-owned startup/header root used by right-panel placement filters. */
	readonly rightPanelHeaderTarget: Component = this.#header;
	readonly #bootstrapInputGap = new Spacer(1);
	readonly #statusHost = new StatusHost();
	readonly #exit: (code: number) => void;
	readonly #now: () => number;
	#preferences: ComposerPreferences;
	#welcome: WelcomeComponent | undefined;
	#version = "";
	#modelName = "";
	#providerName = "";
	#recentSessions: RecentSession[] = [];
	#lspServers: LspServerInfo[] | null = [];

	#headerBefore: readonly Component[] = [];
	#headerAfter: readonly Component[] = [];
	#runtimeChildren: readonly Component[] = [];
	#nativeDock: readonly Component[] | undefined;
	/** Cache-driven status line shown until {@link setStatusComponent} mounts the session's. */
	#startupStatus: StatusLineComponent | undefined;
	#runtimeMounted = false;
	// Composer-owned history id space. Transcript batch ids restart across
	// container clears/swaps; the composer translates them into one monotonic
	// sequence the terminal's accepted-id watermark can trust.
	#nextHistoryId = 1;
	#offeredHistory:
		| {
				id: number;
				rows: readonly string[];
				kind: "append" | "replay";
				source: {
					transcript: TranscriptContainer;
					transcriptId?: number;
					header: "none" | "append" | "replay";
					/** Recomposed header rows to accept as the new retired-header bytes. */
					headerRows?: readonly string[];
				};
		  }
		| undefined;
	#historyReplayRequested = false;
	#allowEmptyHistoryReplay = false;
	#headerReplayPending = false;
	#historyFlush = false;
	// The welcome header retires to terminal history exactly once, after the
	// intro settles; until then it renders as mutable viewport chrome.
	#headerRetired = false;
	// Exact hard rows accepted into native history. Transient resize-alt
	// paints reflow these rows to match the terminal's own rewrap of history
	// it still holds; a settled replay owns every byte it emits, so it
	// recomposes the header at the replay width and refreshes these rows.
	#retiredHeaderRows: readonly string[] | undefined;
	/** Click spans of the last `renderFrame` viewport, in viewport coordinates. */
	#lastClickSpans: ViewportClickSpan[] = [];
	/** Rows of the last `renderFrame` viewport, before the hover band; read to hit-test extension links. */
	#lastViewportRows: readonly string[] = [];
	/** Click-candidate id under the pointer, painted with the hover band. Id-anchored so it follows streaming rows. */
	#hoveredClickId: string | undefined;
	/**
	 * Keyboard link-hint mode: the tags drawn over the extension links on screen (`undefined` until
	 * the first frame after `startLinkHints` assigns them), the letters typed so far, and what to run
	 * when the mode ends for any reason.
	 */
	#linkHints: { hints: ViewportLinkHint[] | undefined; typed: string; onEnd: LinkHintsEnd } | undefined;
	/** Width of the last painted viewport, which `#lastViewportRows` was laid out for. */
	#lastViewportWidth = 0;
	// Hard-row prefix currently above the native viewport. The first resize
	// frame may pull part of it down before the normal buffer is borrowed.
	#retiredHeaderStart = 0;
	#resizeRetiredHeaderStart: number | undefined;
	#lastNormalRows = 0;
	/** Rows the chrome below each below-transcript root took in the last frame (see {@link rowsBelow}). */
	#rowsBelow = new Map<Component, number>();
	#lastInterruptAt = 0;
	/** Last described surface; its arrays are reused while their children are unchanged. */
	#nativeSurface: NativeSurface = { main: [], dock: [] };
	#started = false;
	#stopped = false;
	#transferred = false;

	constructor(options: ComposerOptions = {}) {
		ensureThemeSync();
		// Host-owned hard exit: route through postmortem so a double-Ctrl-C during
		// an open extension-load guard window exits cleanly instead of throwing
		// ExtensionExitError through the guarded process.exit (#11789).
		this.#exit = options.exit ?? (code => postmortem.exitProcess(code));
		this.#now = options.now ?? Date.now;
		this.#preferences = { ...COMPOSER_DEFAULTS, ...options.preferences };
		this.#applyWelcomeUpdate(options.welcome ?? {});

		this.ui = new TUI(
			options.terminal ?? new ProcessTerminal(),
			this.#preferences.showHardwareCursor,
			options.tuiOptions,
		);
		this.ui.setFrameProvider(this);
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		this.ui.setResizeScrollback(this.#preferences.resizeScrollback);

		this.#editor = new CustomEditor(getEditorTheme());
		this.editor.onAutocompleteRender = (rows, cursorOffset, editorRows, anchorCol) =>
			this.ui.setCursorOverlay(rows, cursorOffset, editorRows, "auto", anchorCol);
		this.editor.disableSubmit = true;
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setImeSafeCursorLayout(this.#preferences.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(this.#preferences.autocompleteMaxVisible);
		this.editor.setSpellingFeatures({
			typoDetection: this.#preferences.spellingTypoDetection,
			autocomplete: this.#preferences.spellingAutocomplete,
			autocorrect: this.#preferences.spellingAutocorrect,
		});
		try {
			this.editor.setBorderStyle(this.#preferences.composerShape);
		} catch {
			// Extension-defined styles arrive with the session; InteractiveMode reapplies them.
		}
		if (options.status) {
			const { borderColor, statusLine } = options.status;
			if (borderColor) this.editor.borderColor = text => `${borderColor.prefix}${text}${borderColor.suffix}`;
			this.#startupStatus = createStartupStatusLine(statusLine);
			this.#statusHost.setComponent(this.#startupStatus);
			this.#startupStatus.attachToEditor(this.editor, getComposerStyle(this.#preferences.composerShape));
		}
		// Emergency controls stay active until InteractiveMode installs configured bindings.
		// They deliberately mirror the interactive editor's contract so a stalled startup
		// never behaves differently from a healthy one: Ctrl+C clears the draft and a second
		// press exits 130 — the unconditional abort, draft or not; Ctrl+D exits 0 on an
		// empty draft and otherwise forward-deletes (see CustomEditor's app.exit handling),
		// so typing while the session loads cannot be lost to a mistyped delete.
		this.editor.setActionKeys("app.clear", ["ctrl+c"]);
		this.editor.setActionKeys("app.exit", ["ctrl+d"]);
		this.editor.onClear = () => this.#handleInterrupt();
		this.editor.onExit = () => this.#requestExit(0);
		this.editor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));

		if (!this.#preferences.quiet) this.#ensureWelcome();
		this.#rebuildHeader();
		this.ui.addChild(this.#header);
		this.ui.addChild(this.#bootstrapInputGap);
		this.ui.addChild(this.editor);
		this.ui.addChild(this.#statusHost);
		this.ui.setFocus(this.editor);
	}
	/**
	 * Rows the below-transcript chrome under `root` (editor, status line, …)
	 * took in the last frame, so a root that grows upward can cap itself to
	 * the screen rows left above them; `undefined` before `root` was laid out.
	 */
	rowsBelow(root: Component): number | undefined {
		return this.#rowsBelow.get(root);
	}

	/** Compose the upstream bounded viewport; retirement is owned only by explicit history batches. */
	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		if (!this.#started || this.#stopped) return { viewport: [] };
		this.ui.setCursorOverlay(undefined, 0, 0);
		const width = Math.max(1, viewport.columns);
		const rows = Math.max(0, viewport.rows);
		if (this.#resizeRetiredHeaderStart !== undefined) {
			this.#retiredHeaderStart = this.#resizeRetiredHeaderStart;
			this.#resizeRetiredHeaderStart = undefined;
		}
		this.#lastNormalRows = rows;
		const roots = this.#runtimeMounted
			? [...this.#runtimeChildren, this.#statusHost]
			: [this.#header, this.#bootstrapInputGap, this.editor, this.#statusHost];
		const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
		if (transcriptIndex < 0) {
			this.#lastClickSpans = [];
			this.#lastViewportRows = [];
			this.#syncLinkHints([], 0);
			const viewport: string[] = [];
			for (const root of roots) {
				const rendered = root.render(width);
				viewport.push(...rendered);
			}
			return { viewport: viewport.slice(-rows) };
		}
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		const preChunks = roots
			.slice(0, transcriptIndex)
			.map(component => ({ component, rows: component.render(width) }));
		const preRoots = preChunks.flatMap(chunk => chunk.rows);
		const afterRoots = roots.slice(transcriptIndex + 1);
		const after: string[] = [];
		const afterChunks: { component: Component; rows: readonly string[] }[] = [];
		const afterSpans: ViewportClickSpan[] = [];
		const ends: { root: Component; end: number }[] = [];
		for (const root of afterRoots) {
			const start = after.length;
			this.#renderBelowRoot(root, width, after, afterSpans);
			afterChunks.push({ component: root, rows: after.slice(start) });
			ends.push({ root, end: after.length });
		}
		this.#rowsBelow = new Map(ends.map(({ root, end }) => [root, after.length - end]));
		// Temporary chrome consumes real viewport capacity. Displaced stable
		// content crosses the history gateway instead of becoming hidden state.
		const now = performance.now();
		const frame: AnimationFrame = { now, tick: Math.floor(now / 80) };
		// Retirement measures the same live blocks the viewport lays out below;
		// one open frame renders each of them once for both.
		transcript.beginFrame(frame);
		const history = this.#offerHistory(transcript, width, rows, preRoots.length + after.length);
		const source = this.#offeredHistory?.source;
		const headerOffered = source?.header === "append";
		const headerVisible = !this.#headerRetired && !headerOffered;
		const headerRows = headerVisible ? this.#header.render(width) : [];
		const before = [...headerRows, ...preRoots];
		const active = transcript.renderViewport(width, Math.max(0, rows - before.length - after.length), frame);
		const activeSpans: ViewportClickSpan[] = [];
		for (const span of transcript.getLastViewportSpans()) {
			const ids = (span.component as Partial<{ getClickFocusAgentIds(): string[] }>).getClickFocusAgentIds?.();
			if (!ids || ids.length === 0) continue;
			activeSpans.push({ start: span.start, end: span.end, candidates: () => ids });
		}
		const drop = Math.max(0, before.length + active.length + after.length - rows);
		const mutable = [...before, ...active, ...after].slice(drop);
		const viewportLength = mutable.length;
		const spans: ViewportClickSpan[] = [];
		const shift = (span: ViewportClickSpan, base: number): void => {
			const start = span.start + base;
			const end = Math.min(span.end + base, viewportLength);
			const clamped = Math.max(0, start);
			if (end > clamped) {
				// A clipped head must offset the callback: without the skew the
				// first visible row would hit-test as span-local row 0.
				const skew = clamped - start;
				spans.push({ start: clamped, end, candidates: (local: number) => span.candidates(local + skew) });
			}
		};
		for (const span of activeSpans) shift(span, before.length - drop);
		for (const span of afterSpans) shift(span, before.length + active.length - drop);
		this.#lastClickSpans = spans;
		this.#lastViewportRows = mutable;
		this.#lastViewportWidth = width;
		this.#syncLinkHints(mutable, width);
		if (history !== undefined && headerOffered) {
			const visibleHeaderRows = Math.max(0, rows - (mutable.length + drop));
			const headerLength = source?.headerRows?.length ?? 0;
			this.#retiredHeaderStart = Math.min(headerLength, Math.max(0, history.rows.length - visibleHeaderRows));
		}
		const plan = this.#planWithSegments([
			{ component: this.#header, rows: headerRows },
			...preChunks,
			{ component: transcript, rows: active },
			...afterChunks,
		]);
		return {
			history,
			viewport: this.#paintLinkHints(this.#paintHoverBand(mutable, spans), width),
			segments: plan.segments.map(segment => ({ ...segment, start: segment.start - drop })),
		};
	}

	/**
	 * Keep link-hint tags on what `rows` show. The first frame after `startLinkHints` tags its
	 * labels; later frames keep the tags while the tagged labels are still drawn first, in the same
	 * order and columns (rows may scroll, links may be added below), and otherwise end the mode, so a
	 * tag never picks a label no longer drawn under it. Every frame ends the mode as `"crowded"` when
	 * some row has more tag cells than `width` (a resize can narrow it), since tags drawn side by
	 * side could not all be read.
	 */
	#syncLinkHints(rows: readonly string[], width: number): void {
		const state = this.#linkHints;
		if (state === undefined) return;
		const targets = viewportLinkTargets(rows);
		const hints = state.hints;
		if (hints === undefined) {
			state.hints = linkHintTags(targets.length).map((tag, index) => ({ tag, link: targets[index]! }));
			if (state.hints.length === 0) {
				this.#endLinkHints();
				return;
			}
		} else {
			const unchanged =
				targets.length >= hints.length &&
				hints.every(({ link }, index) => link.url === targets[index]!.url && link.start === targets[index]!.start);
			if (!unchanged) {
				this.#endLinkHints();
				return;
			}
			state.hints = hints.map(({ tag }, index) => ({ tag, link: targets[index]! }));
		}
		const cells = new Map<number, number>();
		for (const { tag, link } of state.hints) cells.set(link.row, (cells.get(link.row) ?? 0) + tag.length);
		if ([...cells.values()].some(count => count > width)) this.#endLinkHints("crowded");
	}

	#endLinkHints(reason?: "crowded"): void {
		const state = this.#linkHints;
		if (state === undefined) return;
		this.#linkHints = undefined;
		state.onEnd(reason);
	}

	/**
	 * Draw every tag the typed letters still lead to over the start of its label. Tags on one row
	 * never overlap: one that would land on an earlier tag moves right, and tags that would run past
	 * the right edge move left, so each stays readable as long as the row has room for them all.
	 */
	#paintLinkHints(viewport: string[], width: number): string[] {
		const state = this.#linkHints;
		if (state?.hints === undefined) return viewport;
		const rows = new Map<number, { tag: string; col: number }[]>();
		for (const { tag, link } of state.hints) {
			if (viewport[link.row] === undefined || !tag.startsWith(state.typed)) continue;
			let row = rows.get(link.row);
			if (!row) rows.set(link.row, (row = []));
			row.push({ tag, col: link.start });
		}
		const painted = [...viewport];
		for (const [index, tags] of rows) {
			tags.sort((a, b) => a.col - b.col);
			let free = 0;
			for (const placed of tags) {
				placed.col = Math.max(placed.col, free);
				free = placed.col + placed.tag.length;
			}
			let limit = width;
			for (let i = tags.length - 1; i >= 0; i--) {
				const placed = tags[i]!;
				placed.col = Math.max(0, Math.min(placed.col, limit - placed.tag.length));
				limit = placed.col;
			}
			let line = painted[index]!;
			for (const { tag, col } of tags) {
				// Raw SGR like the hover highlight: chalk's inverse/bold drop out when it detects no color.
				const styled = `\x1b[1;7m${theme.fg("accent", tag)}\x1b[22;27m`;
				line = compositeLineAt(line, styled, col, tag.length, width);
			}
			painted[index] = line;
		}
		return painted;
	}

	/**
	 * Describe the whole surface for a TSP terminal. `main` is the flowing
	 * document: the header (welcome, extras) and every transcript block as its
	 * own component child. `dock` is the live chrome below the transcript in
	 * render order: pending messages, HUDs, the working row, the editor and the
	 * status line. There is no history/viewport split: retirement, resize
	 * replay and hover bands are ANSI concerns.
	 */
	describeSurface(): NativeSurface {
		if (!this.#started || this.#stopped) return this.#nativeSurface;
		const main: NativeChild[] = [...this.#header.children];
		const dock: NativeChild[] = [];
		if (!this.#runtimeMounted) {
			// The bootstrap gap is row spacing; the terminal owns the dock layout.
			dock.push(this.editor);
		} else {
			const roots = this.#runtimeChildren;
			const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
			if (transcriptIndex < 0) {
				dock.push(...roots);
			} else {
				const transcript = roots[transcriptIndex] as TranscriptContainer;
				main.push(...roots.slice(0, transcriptIndex), ...transcript.nativeBlocks());
				dock.push(...(this.#nativeDock ?? roots.slice(transcriptIndex + 1)));
			}
		}
		const previous = this.#nativeSurface;
		const nextMain = sameItems(previous.main, main) ? previous.main : main;
		const nextDock = sameItems(previous.dock, dock) ? previous.dock : dock;
		if (nextMain !== previous.main || nextDock !== previous.dock) {
			this.#nativeSurface = { main: nextMain, dock: nextDock };
		}
		return this.#nativeSurface;
	}

	/**
	 * Append one below-transcript root's rows to `after`, recording click spans
	 * for its row targets in `after` coordinates.
	 *
	 * Row targets usually nest one level down: chrome roots are plain
	 * containers (the HUD lives inside `subagentContainer`), and
	 * `Container.render` is a pure concatenation, so child spans tile the root
	 * span exactly. Render those children once and share the rows for
	 * composition and measurement — a second render per frame would duplicate
	 * render-time side effects (image placement registration). Roots with a
	 * custom render keep the composed output as the source of truth and measure
	 * up to the last target.
	 */
	#renderBelowRoot(root: Component, width: number, after: string[], spans: ViewportClickSpan[]): void {
		const start = after.length;
		const plainContainer = root instanceof Container && root.render === Container.prototype.render;
		const targets = root instanceof Container ? root.children : [root];
		const resolves = targets.map(rowTargetCandidates);
		const lastTarget = resolves.findLastIndex(resolve => resolve !== undefined);
		if (plainContainer) {
			let offset = start;
			for (let index = 0; index < targets.length; index++) {
				const childLines = targets[index]!.render(width);
				after.push(...childLines);
				if (index > lastTarget) continue;
				const resolve = resolves[index];
				if (resolve !== undefined && childLines.length > 0) {
					spans.push({ start: offset, end: offset + childLines.length, candidates: resolve });
				}
				offset += childLines.length;
			}
			return;
		}
		after.push(...root.render(width));
		if (lastTarget === -1) return;
		let offset = start;
		for (let index = 0; index <= lastTarget; index++) {
			const childLines = targets[index] === root ? after.length - start : targets[index]!.render(width).length;
			const resolve = resolves[index];
			if (resolve !== undefined && childLines > 0) {
				spans.push({ start: offset, end: offset + childLines, candidates: resolve });
			}
			offset += childLines;
		}
	}

	/**
	 * Band the hovered click target's current rows. Id-anchored (not
	 * line-anchored) so the band follows an agent whose rows shift while it
	 * streams; a retired id matches no span and simply paints nothing. Only
	 * the viewport copy is banded — retirement reads unbanded component rows.
	 */
	#paintHoverBand(viewport: string[], spans: readonly ViewportClickSpan[]): string[] {
		const hovered = this.#hoveredClickId;
		if (hovered === undefined) return viewport;
		let banded = false;
		const painted = viewport.map((line, index) => {
			for (const span of spans) {
				if (index < span.start || index >= span.end) continue;
				if (!span.candidates(index - span.start).includes(hovered)) continue;
				banded = true;
				// A wrapping band loses to background opens nested inside the row
				// (live card rows carry the pending-tint bg, which would paint over
				// the band for every cell it covers), so drop nested bg opens
				// first; their closes stay and become band resumes via bgFill.
				return theme.bgFill("selectedBg", line.replace(NESTED_BG_OPEN_PATTERN, ""));
			}
			return line;
		});
		return banded ? painted : viewport;
	}

	/**
	 * Candidate subagent ids under a mutable-viewport line, for click-to-focus.
	 * Empty when the line has no click target (chrome, separators, retired rows
	 * are never in the viewport). Callers intersect with the live registry.
	 */
	viewportClickCandidates(index: number): string[] {
		return routeViewportClick(this.#lastClickSpans, index);
	}

	/**
	 * The extension-owned link label drawn at cell `col` of a mutable-viewport line, or `undefined`.
	 * Only links whose scheme an extension registered match; see `extensionLinkLabels`.
	 */
	viewportLinkAt(index: number, col: number): ViewportLink | undefined {
		const line = this.#lastViewportRows[index];
		if (line === undefined || col < 0) return undefined;
		const label = extensionLinkLabels(line).find(label => col >= label.start && col < label.end);
		return label && { url: label.url, row: index, start: label.start };
	}

	/**
	 * Point the hover band at a click-candidate id (or clear it). Takes effect
	 * on the next frame; callers repaint only when the target actually changes.
	 */
	setHoveredClickId(id: string | undefined): void {
		this.#hoveredClickId = id;
	}

	/** Publish component ownership for every row in the complete logical frame. */
	#planWithSegments(
		chunks: readonly { component: Component; rows: readonly string[] }[],
		borrowableRows?: number,
	): {
		viewport: string[];
		segments: TerminalFrameSegment[];
		borrowableRows?: number;
	} {
		const viewport: string[] = [];
		const segments: TerminalFrameSegment[] = [];
		for (const chunk of chunks) {
			segments.push({ component: chunk.component, start: viewport.length, rowCount: chunk.rows.length });
			viewport.push(...chunk.rows);
		}
		return { viewport, segments, borrowableRows };
	}

	/** How many extension link labels the last frame drew; a label wrapped across rows counts once. */
	viewportLinkCount(): number {
		return viewportLinkTargets(this.#lastViewportRows).length;
	}

	/**
	 * Enter keyboard link-hint mode: the next frame draws a tag over each extension link label it
	 * shows. `onEnd` runs once when the mode ends: a pick, a cancel, a key no tag starts with, a
	 * repaint that no longer draws the tagged labels where they were, or (`"crowded"`) a row with
	 * too many links for their tags to fit side by side.
	 */
	startLinkHints(onEnd: LinkHintsEnd): void {
		this.#endLinkHints();
		this.#linkHints = { hints: undefined, typed: "", onEnd };
	}

	/** Whether link-hint mode is on. */
	get linkHintsActive(): boolean {
		return this.#linkHints !== undefined;
	}

	/**
	 * Type one letter of a tag. Returns the link whose whole tag is now typed, `true` while the
	 * letters still lead to several tags, and `false` when none starts with them. The mode ends on
	 * a pick or a miss.
	 */
	typeLinkHint(letter: string): ViewportLink | boolean {
		const state = this.#linkHints;
		if (state === undefined) return false;
		// A key typed before the tags were first painted picks among the labels last drawn.
		if (state.hints === undefined) this.#syncLinkHints(this.#lastViewportRows, this.#lastViewportWidth);
		const hints = this.#linkHints?.hints;
		if (hints === undefined) return false;
		const typed = state.typed + letter.toLowerCase();
		const matching = hints.filter(hint => hint.tag.startsWith(typed));
		const picked = matching.length === 1 && matching[0]!.tag === typed ? matching[0]!.link : undefined;
		if (matching.length === 0 || picked !== undefined) {
			this.#endLinkHints();
			return picked ?? false;
		}
		state.typed = typed;
		return true;
	}

	/** Leave link-hint mode without picking a link. */
	cancelLinkHints(): void {
		this.#endLinkHints();
	}

	/** Acknowledges one accepted header, replay, or transcript batch. */
	acknowledgeHistory(id: number): void {
		const offered = this.#offeredHistory;
		if (offered === undefined || offered.id !== id) return;
		if (offered.source.transcriptId !== undefined) {
			offered.source.transcript.acknowledgeFinalizedBatch(offered.source.transcriptId);
		}
		if (offered.source.header !== "none") {
			this.#headerRetired = true;
			this.#headerReplayPending = false;
			if (offered.source.headerRows !== undefined) this.#retiredHeaderRows = offered.source.headerRows;
		}
		this.#offeredHistory = undefined;
		if (this.#historyReplayRequested) this.#startHistoryReplay();
		// Publish an exposed ready stage immediately; this repaints only the
		// viewport, never clears scrollback or requests a history replay.
		this.ui.requestRender(true);
	}

	/** Render the semantic transcript tail while the terminal borrows its resize buffer. */
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		if (!this.#started || this.#stopped) return [];
		const width = Math.max(1, viewport.columns);
		const rows = Math.max(0, viewport.rows);
		const tail = this.#runtimeMounted
			? this.#renderResizeTail(width, rows)
			: this.#renderRoots([this.#bootstrapInputGap, this.editor, this.#statusHost], width);
		let header: readonly string[];
		if (this.#headerRetired) {
			this.#resizeRetiredHeaderStart ??= Math.max(
				0,
				this.#retiredHeaderStart - Math.max(0, rows - this.#lastNormalRows),
			);
			header = this.#reflowRetiredHeader(width, this.#resizeRetiredHeaderStart);
		} else {
			header = this.#header.render(width);
		}
		const rendered = [...header, ...tail];
		return rendered.length <= rows ? rendered : rendered.slice(rendered.length - rows);
	}

	/** Replays committed presentation without changing logical retirement state. */
	beginHistoryReplay(allowEmptyReplay = false): "deferred" | undefined {
		this.#allowEmptyHistoryReplay ||= allowEmptyReplay;
		if (this.#offeredHistory !== undefined) {
			this.#historyReplayRequested = true;
			return "deferred";
		}
		this.#startHistoryReplay();
		return undefined;
	}

	/** Forces every currently eligible finalized prefix to retire before stop. */
	beginHistoryFlush(): void {
		this.#historyFlush = true;
		// A pending replay would re-render and re-stream the entire committed
		// ledger during shutdown; the terminal already holds that history, so
		// flush emits only genuinely un-retired rows. An already offered batch
		// stays valid and is accepted by the flush loop.
		this.#historyReplayRequested = false;
		this.#allowEmptyHistoryReplay = false;
		this.#headerReplayPending = false;
		for (const child of this.#runtimeChildren) {
			if (child instanceof TranscriptContainer) child.cancelReplay();
		}
	}

	#startHistoryReplay(): void {
		this.#headerReplayPending = this.#headerRetired && (this.#retiredHeaderRows?.length ?? 0) > 0;
		this.#historyReplayRequested = false;
		for (const child of this.#runtimeChildren) {
			if (child instanceof TranscriptContainer) child.beginReplay(this.#allowEmptyHistoryReplay);
		}
		this.#allowEmptyHistoryReplay = false;
	}

	/** Publish header and child atomically; replay coalesces the complete committed ledger. */
	#offerHistory(
		transcript: TranscriptContainer,
		width: number,
		rows: number,
		chromeRows: number,
	): { id: number; rows: readonly string[]; kind: "append" | "replay" } | undefined {
		if (this.#offeredHistory !== undefined) {
			this.#rerenderOfferedHistory(width);
			return {
				id: this.#offeredHistory.id,
				rows: this.#offeredHistory.rows,
				kind: this.#offeredHistory.kind,
			};
		}
		if (this.#headerReplayPending) {
			const transcriptReplay = transcript.peekReplayBatch(width);
			// A replay follows a scrollback clear, so the header recomposes at
			// the new width exactly like transcript entries do. An empty
			// recompose (welcome unmounted after retirement) falls back to the
			// committed rows, hard-wrapped the way the terminal would.
			const recomposed = this.#header.render(width);
			const headerRows = recomposed.length > 0 ? [...recomposed, ""] : this.#reflowRetiredHeader(width, 0);
			this.#offeredHistory = {
				id: this.#nextHistoryId++,
				rows: [...headerRows, ...(transcriptReplay?.rows ?? [])],
				kind: "replay",
				source: {
					transcript,
					transcriptId: transcriptReplay?.id,
					header: "replay",
					headerRows,
				},
			};
			return {
				id: this.#offeredHistory.id,
				rows: this.#offeredHistory.rows,
				kind: this.#offeredHistory.kind,
			};
		}
		if (!this.#headerRetired) {
			const welcome = this.#welcome;
			if (welcome !== undefined && !welcome.isTranscriptBlockFinalized()) return undefined;
			// The header stays live viewport chrome until the screen fills; then it
			// retires first so transcript prefixes can follow in order.
			const renderedHeader = this.#header.render(width);
			if (renderedHeader.length > 0) {
				// Only the comparison below reads the height, so the walk stops at
				// the budget instead of rendering every replayed block (#12933).
				const liveRows = transcript.liveRowCount(width, Math.max(0, rows - renderedHeader.length - chromeRows));
				const childBatch = this.#historyFlush
					? transcript.peekFlushBatch(width)
					: transcript.peekFinalizedBatch(width, Math.max(0, rows - chromeRows));
				if (!childBatch && !this.#historyFlush && renderedHeader.length + chromeRows + liveRows <= rows)
					return undefined;
				const headerRows = [...renderedHeader, ""];
				this.#offeredHistory = {
					id: this.#nextHistoryId++,
					rows: [...headerRows, ...(childBatch?.rows ?? [])],
					kind: "append",
					source: { transcript, transcriptId: childBatch?.id, header: "append", headerRows },
				};
				return {
					id: this.#offeredHistory.id,
					rows: this.#offeredHistory.rows,
					kind: this.#offeredHistory.kind,
				};
			}
			this.#headerRetired = true;
			this.#retiredHeaderRows = [];
		}
		const batch = this.#historyFlush
			? transcript.peekFlushBatch(width)
			: transcript.peekFinalizedBatch(width, Math.max(0, rows - chromeRows));
		if (batch === undefined) return undefined;
		this.#offeredHistory = {
			id: this.#nextHistoryId++,
			rows: batch.rows,
			kind: batch.kind ?? "append",
			source: { transcript, transcriptId: batch.id, header: "none" },
		};
		return {
			id: this.#offeredHistory.id,
			rows: this.#offeredHistory.rows,
			kind: this.#offeredHistory.kind,
		};
	}

	#rerenderOfferedHistory(width: number): void {
		const offered = this.#offeredHistory;
		if (offered === undefined) return;
		const transcript = offered.source.transcript.rerenderOfferedBatch(width);
		if (offered.source.header === "none") {
			if (transcript !== undefined) offered.rows = transcript.rows;
			return;
		}
		const recomposed = this.#header.render(width);
		const headerRows = recomposed.length > 0 ? [...recomposed, ""] : this.#reflowRetiredHeader(width, 0);
		offered.source.headerRows = headerRows;
		offered.rows = [...headerRows, ...(transcript?.rows ?? [])];
	}

	#renderRoots(roots: readonly Component[], width: number): string[] {
		const rows: string[] = [];
		for (const root of roots) rows.push(...root.render(width));
		return rows;
	}
	/**
	 * Mounted-runtime rows for the transient resize buffer. Only the trailing
	 * viewport can survive the caller's bottom slice, so the transcript renders
	 * a bounded tail instead of the full committed ledger, and the chrome above
	 * it renders only when that tail underfills the screen.
	 */
	#renderResizeTail(width: number, rows: number): string[] {
		const roots = [...this.#runtimeChildren, this.#statusHost];
		const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
		if (transcriptIndex < 0) return this.#renderRoots(roots, width);
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		const after = this.#renderRoots(roots.slice(transcriptIndex + 1), width);
		const transcriptRows = transcript.renderTail(width, Math.max(0, rows - after.length));
		const pre =
			transcriptRows.length + after.length >= rows ? [] : this.#renderRoots(roots.slice(0, transcriptIndex), width);
		return [...pre, ...transcriptRows, ...after];
	}

	/** Reflow accepted hard rows exactly as the restored terminal buffer will. */
	#reflowRetiredHeader(width: number, start: number): string[] {
		const lines = this.#retiredHeaderRows;
		if (!lines) return [];
		if (isInsideTerminalMultiplexer()) return lines.slice(start);
		const reflowed: string[] = [];
		for (let index = start; index < lines.length; index++) {
			reflowed.push(...wrapLiteralLine(lines[index]!, width));
		}
		return reflowed;
	}

	/** Live editor whose draft survives startup and session adoption. */
	get editor(): CustomEditor {
		return this.#editor;
	}

	/** The welcome component currently mounted in the header, if quiet mode is off. */
	get welcome(): WelcomeComponent | undefined {
		return this.#welcome;
	}

	/** Whether this composer already owns the terminal render/input loop. */
	get started(): boolean {
		return this.#started && !this.#stopped;
	}

	/** Start terminal ownership and optionally begin the welcome intro. */
	start(options: ComposerStartOptions = {}): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		// A TSP terminal keeps (and draws) what is typed until startup releases
		// the held input, standing in for the kernel echo other terminals give.
		this.#editor.nativeTypeahead = options.deferInput === true;
		this.ui.start({ clearScrollback: options.clearScrollback === true, deferInput: options.deferInput === true });
		if (options.playWelcomeIntro !== false) this.playWelcomeIntro();
		// Deferred input identifies the CLI prepaint handoff. Flush the queued
		// forced frame before returning so subsequent dynamic-import evaluation
		// cannot monopolize the event loop ahead of the speculative status chrome.
		if (options.deferInput === true) this.ui.renderNow({ clearScrollback: options.clearScrollback === true });
	}
	/** Take raw-input ownership after a deferred-input start. Idempotent. */
	enableInput(): void {
		if (this.#stopped) return;
		this.ui.enableInput();
	}

	/** Apply settings changes without replacing the editor or welcome component. */
	setPreferences(update: Partial<ComposerPreferences>): void {
		if (this.#stopped) return;
		const wasQuiet = this.#preferences.quiet;
		this.#preferences = { ...this.#preferences, ...update };
		this.editor.setTheme(getEditorTheme());
		try {
			this.editor.setBorderStyle(this.#preferences.composerShape);
		} catch {
			// Extension-defined styles arrive with the session; InteractiveMode reapplies them.
		}
		this.ui.setShowHardwareCursor(this.#preferences.showHardwareCursor);
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		if (update.resizeScrollback !== undefined) this.ui.setResizeScrollback(update.resizeScrollback);
		this.editor.setImeSafeCursorLayout(this.#preferences.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(this.#preferences.autocompleteMaxVisible);
		this.editor.setSpellingFeatures({
			typoDetection: this.#preferences.spellingTypoDetection,
			autocomplete: this.#preferences.spellingAutocomplete,
			autocorrect: this.#preferences.spellingAutocorrect,
		});
		this.#startupStatus?.attachToEditor(this.editor, getComposerStyle(this.#preferences.composerShape));
		if (this.#preferences.quiet) {
			this.#welcome?.stopIntro();
			this.#welcome = undefined;
		} else {
			this.#ensureWelcome();
			this.#welcome?.invalidate();
			if (wasQuiet && this.#started) this.playWelcomeIntro();
		}
		if (wasQuiet !== this.#preferences.quiet) this.#rebuildHeader();
		this.ui.requestRender();
	}

	/** Patch welcome data in place as version, session, and project discovery complete. */
	updateWelcome(update: ComposerWelcomeUpdate): void {
		if (this.#stopped) return;
		this.#applyWelcomeUpdate(update);
		if (this.#preferences.quiet) return;
		this.#ensureWelcome();
		const welcome = this.#welcome;
		if (!welcome) return;
		if (update.version !== undefined) welcome.setVersion(this.#version);
		if (update.modelName !== undefined || update.providerName !== undefined) {
			welcome.setModel(this.#modelName, this.#providerName);
		}
		if (update.recentSessions !== undefined) welcome.setRecentSessions(this.#recentSessions);
		if (update.lspServers !== undefined) welcome.setLspServers(this.#lspServers);
		this.ui.requestRender();
	}

	/** Replace optional header content around the stable welcome scene. */
	setHeaderExtras(before: readonly Component[], after: readonly Component[]): void {
		if (this.#stopped) return;
		this.#headerBefore = before;
		this.#headerAfter = after;
		this.#rebuildHeader();
		this.ui.requestRender();
	}

	/** Update the canonical editor reference after InteractiveMode remounts a custom editor. */
	setEditor(editor: CustomEditor): void {
		this.ui.replaceHeldFocus(this.#editor, editor);
		editor.nativeTypeahead = this.#editor.nativeTypeahead;
		this.#editor = editor;
	}

	/**
	 * End the startup input hold once the app's handlers are wired: the TSP
	 * terminal sends the typing it kept, and the keys the TUI held replay
	 * ({@link TUI.releaseHeldInput}). Idempotent.
	 */
	releaseHeldInput(): void {
		if (this.#editor.nativeTypeahead) {
			this.#editor.nativeTypeahead = false;
			this.ui.requestRender();
		}
		this.ui.releaseHeldInput();
	}

	/**
	 * Mount the session-aware status component into the slot below the editor,
	 * retiring the startup status line; the caller installs the real top-border
	 * provider through its composer-shape sync.
	 */
	setStatusComponent<TSession extends StatusLineSession>(component: StatusLineComponent<TSession>): void {
		if (this.#startupStatus) component.adoptGitStatus(this.#startupStatus);
		this.#disposeStartupStatus();
		this.#statusHost.setComponent(component);
		this.editor.setTopBorderProvider(undefined);
		this.editor.composerFacts = component;
	}

	#disposeStartupStatus(): void {
		this.#startupStatus?.dispose();
		this.#startupStatus = undefined;
	}

	/** Mount or replace session-aware root children while preserving the header and status hosts. */
	setRuntimeChildren(children: readonly Component[], options: RuntimeChildrenOptions = {}): void {
		if (this.#stopped) return;
		this.#nativeDock = options.nativeDock;
		this.ui.removeChild(this.#statusHost);
		if (this.#runtimeMounted) {
			for (const child of this.#runtimeChildren) this.ui.removeChild(child);
		} else {
			this.ui.removeChild(this.#bootstrapInputGap);
			this.ui.removeChild(this.editor);
			this.#runtimeMounted = true;
		}
		this.#runtimeChildren = children;
		for (const child of children) this.ui.addChild(child);
		this.ui.addChild(this.#statusHost);
		this.ui.requestRender();
	}

	/** Play or replay the welcome intro against the stable header render target. */
	playWelcomeIntro(): void {
		this.#welcome?.playIntro(() => this.ui.requestComponentRender(this.#header));
	}

	/** Transfer terminal ownership to InteractiveMode without stopping the composer. */
	transfer(): void {
		if (!this.#started || this.#stopped || this.#transferred) {
			throw new Error("Composer is not available for transfer");
		}
		this.#transferred = true;
	}

	/** Stop a composer that has not transferred terminal ownership. */
	stop(): void {
		if (!this.#started || this.#stopped || this.#transferred) return;
		this.#welcome?.stopIntro();
		this.#disposeStartupStatus();
		this.ui.stop();
		this.#stopped = true;
	}

	#applyWelcomeUpdate(update: ComposerWelcomeUpdate): void {
		if (update.version !== undefined) this.#version = update.version;
		if (update.modelName !== undefined) this.#modelName = update.modelName;
		if (update.providerName !== undefined) this.#providerName = update.providerName;
		if (update.recentSessions !== undefined) this.#recentSessions = [...update.recentSessions];
		if (update.lspServers !== undefined) this.#lspServers = update.lspServers && [...update.lspServers];
	}

	#ensureWelcome(): void {
		this.#welcome ??= new WelcomeComponent(
			this.#version,
			this.#modelName,
			this.#providerName,
			this.#recentSessions,
			this.#lspServers,
		);
	}

	#rebuildHeader(): void {
		this.#header.clear();
		for (const component of this.#headerBefore) this.#header.addChild(component);
		if (this.#welcome) {
			this.#header.addChild(new Spacer(1));
			this.#header.addChild(this.#welcome);
			this.#header.addChild(new Spacer(1));
		}
		for (const component of this.#headerAfter) this.#header.addChild(component);
	}

	#handleInterrupt(): void {
		const now = this.#now();
		if (now - this.#lastInterruptAt < DOUBLE_INTERRUPT_MS) {
			this.#requestExit(130);
			return;
		}
		this.editor.setText("");
		this.#lastInterruptAt = now;
	}

	#requestExit(code: number): void {
		// Remains live after transfer until InteractiveMode installs its configured handlers.
		if (this.#stopped) return;
		this.#welcome?.stopIntro();
		if (this.#started) this.ui.stop();
		this.#stopped = true;
		this.#exit(code);
	}
}
