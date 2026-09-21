/**
 * Live event-loop phase breadcrumb. Hot synchronous paths push a short label
 * before running and pop it after (via `try`/`finally`); the loop watchdog
 * reads {@link takeRecentLoopPhase} when it detects a block, so a stall is
 * logged with the work that caused it instead of an opaque "unknown".
 *
 * This is deliberately a process-global stack and not part of the logger span
 * machinery: `main.ts` ends timing spans before the interactive TUI starts, so
 * `logger.openSpanPath()` is empty in a live session.
 *
 * Correctness constraint: each `pushLoopPhase` must be balanced by a
 * `popLoopPhase` within the SAME synchronous execution (always via `try`/
 * `finally`). The stack is global and shared, so a label held across an
 * `await`/async boundary — or interleaved between concurrent tasks — would
 * misattribute or leak phases. Instrument only synchronous spans; for async
 * work, push/pop around each synchronous chunk, not across the await.
 */
interface HeldPhase {
	label: string;
	/** When this phase last became the top of the stack. */
	resumedAt: number;
	/** Exclusive time accrued so far while it was on top. */
	exclusiveMs: number;
}
const stack: HeldPhase[] = [];
// Exclusive wall time per label since the watchdog last consumed it. A blocked
// interval spans several macrotasks, and the label pushed LAST is rarely the one
// that consumed the interval: a 900 ms compose followed by a 50 ms emit must be
// reported as the compose. Attribution therefore goes to the label with the
// most exclusive time, not the most recent one.
const accrued = new Map<string, number>();
let recentPhase: string | undefined;

function now(): number {
	return performance.now();
}

function credit(label: string, ms: number): void {
	if (ms <= 0) return;
	accrued.set(label, (accrued.get(label) ?? 0) + ms);
}

export function pushLoopPhase(label: string): void {
	const at = now();
	const parent = stack[stack.length - 1];
	if (parent !== undefined) {
		// Nested phases accrue exclusively: pause the parent while a child holds
		// the top, or the outer label would always win and sub-phases stay invisible.
		parent.exclusiveMs += at - parent.resumedAt;
	}
	stack.push({ label, resumedAt: at, exclusiveMs: 0 });
	recentPhase = label;
}

export function popLoopPhase(): void {
	const at = now();
	const top = stack.pop();
	if (top === undefined) return;
	credit(top.label, top.exclusiveMs + (at - top.resumedAt));
	const parent = stack[stack.length - 1];
	if (parent !== undefined) parent.resumedAt = at;
}

export function currentLoopPhase(): string | undefined {
	return stack[stack.length - 1]?.label;
}

/**
 * Phase to blame for a just-detected loop block: the label that accrued the
 * most exclusive time since the last call, including whatever the live top
 * phase has held so far. Falls back to the most recent label when nothing has
 * accrued (a phase pushed but not yet measurable). Consumes the accounting so a
 * later, phase-less interval is not blamed on work that already finished.
 */
export function takeRecentLoopPhase(): string | undefined {
	const at = now();
	const totals = new Map(accrued);
	const top = stack[stack.length - 1];
	// Every held entry contributes what it accrued while on top; a parent
	// paused under a child must not lose that at the tick, or attribution
	// would drift toward leaf labels. Only the live top is still counting.
	for (const held of stack) {
		const live = held === top ? at - held.resumedAt : 0;
		totals.set(held.label, (totals.get(held.label) ?? 0) + held.exclusiveMs + live);
	}
	let best: string | undefined;
	let bestMs = 0;
	for (const [label, ms] of totals) {
		if (ms > bestMs) {
			best = label;
			bestMs = ms;
		}
	}
	// A still-held phase is where the block currently is; only a finished
	// phase that clearly out-consumed it takes the blame away. Sub-millisecond
	// differences are noise, not evidence.
	let phase = best ?? top?.label ?? recentPhase;
	if (top !== undefined && best !== top.label && bestMs - (totals.get(top.label) ?? 0) < 1) {
		phase = top.label;
	}
	accrued.clear();
	recentPhase = undefined;
	// The live top keeps counting from now; what it held before is consumed.
	for (const held of stack) {
		held.exclusiveMs = 0;
		held.resumedAt = at;
	}
	return phase;
}
