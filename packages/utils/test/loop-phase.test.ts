import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { currentLoopPhase, popLoopPhase, pushLoopPhase, takeRecentLoopPhase } from "@oh-my-pi/pi-utils";

/**
 * Contract: the loop-phase breadcrumb is a LIFO string stack. `currentLoopPhase()`
 * reports the most recently pushed, still-unpopped label and `undefined` once the
 * stack drains. The watchdog reads this to name the work that blocked the loop, so
 * the ordering and empty-state behavior are the externally observable guarantee.
 *
 * The stack is a process-global; drain it around each case so a leaked phase from
 * this or any other suite cannot poison an assertion or leak outward.
 */
function drain(): void {
	while (currentLoopPhase() !== undefined) popLoopPhase();
	takeRecentLoopPhase(); // clear the consume-on-read recent slot between cases
}

beforeEach(drain);
afterEach(drain);

describe("loop phase stack", () => {
	test("currentLoopPhase() is undefined on an empty stack", () => {
		expect(currentLoopPhase()).toBeUndefined();
	});

	test("push/pop expose the top label in strict LIFO order through nested phases", () => {
		pushLoopPhase("render");
		expect(currentLoopPhase()).toBe("render");

		pushLoopPhase("layout");
		expect(currentLoopPhase()).toBe("layout");

		pushLoopPhase("paint");
		expect(currentLoopPhase()).toBe("paint");

		// Unwinding reveals each enclosing phase in reverse insertion order.
		popLoopPhase();
		expect(currentLoopPhase()).toBe("layout");

		popLoopPhase();
		expect(currentLoopPhase()).toBe("render");

		popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();
	});

	test("popping an already-empty stack stays undefined without underflow", () => {
		// Unbalanced pops (error paths popping more than they pushed) must not throw
		// or wrap around to a stale label.
		popLoopPhase();
		popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();

		// And the stack is still usable afterward.
		pushLoopPhase("after-underflow");
		expect(currentLoopPhase()).toBe("after-underflow");
	});

	test("takeRecentLoopPhase surfaces a popped phase once, then clears it", () => {
		// A synchronous hot path pushes then pops its phase entirely before the
		// watchdog's delayed tick runs, so the live stack is empty by then.
		pushLoopPhase("ui.select-filter");
		popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();

		// The recent slot still names the just-finished phase for that one read,
		// then is consumed so a later phase-less block is not blamed on it.
		expect(takeRecentLoopPhase()).toBe("ui.select-filter");
		expect(takeRecentLoopPhase()).toBeUndefined();
	});

	test("takeRecentLoopPhase prefers a still-held live phase over the recent slot", () => {
		pushLoopPhase("outer"); // stays held across the inner phase
		pushLoopPhase("inner");
		popLoopPhase(); // inner done; recent slot last saw "inner", outer still live

		// A live phase wins over the recent slot — the block is still inside it.
		expect(takeRecentLoopPhase()).toBe("outer");
		popLoopPhase();
	});

	test("blames the phase that consumed the interval, not the one pushed last", () => {
		// Regression: a blocked interval spans several macrotasks. A long compose
		// followed by a short emit used to be reported as the emit because it
		// was pushed last, steering the investigation at the wrong half of a
		// paint. Attribution goes to exclusive wall time.
		pushLoopPhase("ui:render:compose");
		Bun.sleepSync(12);
		popLoopPhase();
		pushLoopPhase("ui:render:emit");
		Bun.sleepSync(2);
		popLoopPhase();
		expect(takeRecentLoopPhase()).toBe("ui:render:compose");
	});

	test("nested phases accrue exclusive time so a sub-phase can outweigh its parent", () => {
		pushLoopPhase("ui:render");
		Bun.sleepSync(2);
		pushLoopPhase("ui:render:compose");
		Bun.sleepSync(12);
		popLoopPhase();
		popLoopPhase();
		// Without pausing the parent while the child holds the top, the outer
		// label would always win and sub-phases would be invisible.
		expect(takeRecentLoopPhase()).toBe("ui:render:compose");
	});

	test("a parent paused under a child keeps its accrued time across a watchdog read", () => {
		pushLoopPhase("ui:render");
		Bun.sleepSync(12);
		pushLoopPhase("ui:render:emit");
		Bun.sleepSync(2);
		// The tick lands while the child still holds the top. The parent did the
		// work; zeroing only the top's ledger would hand the blame to the leaf.
		expect(takeRecentLoopPhase()).toBe("ui:render");
		popLoopPhase();
		popLoopPhase();
	});
});
