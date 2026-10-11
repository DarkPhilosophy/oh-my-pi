import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type SelectItem, SelectList, type SelectListTheme } from "@oh-my-pi/pi-tui";
import { currentLoopPhase, popLoopPhase, resetLoopPhaseWindow } from "@oh-my-pi/pi-utils";

/**
 * Contract: the SelectList fuzzy filter — a synchronous, potentially expensive
 * pass over a large list — is wrapped in a `ui.select-filter` loop-phase
 * breadcrumb so the event-loop watchdog can attribute a filter stall to it.
 *
 * The LoopWatchdog unit tests cover the watchdog/attribution mechanism in
 * isolation; this guards the actual call site. Removing the
 * `pushLoopPhase("ui.select-filter")` around the filter would leave a real stall
 * logged as "unknown" while every watchdog unit test still passed — and this
 * case would fail.
 *
 * The phase stack and attribution window are process-global; drain both after
 * each case so nothing leaks across tests.
 */
// Observe the phase inside the actual fuzzy-filter work, not after it returns.
function drain(): void {
	resetLoopPhaseWindow();
	while (currentLoopPhase() !== undefined) popLoopPhase();
}
beforeEach(drain);
afterEach(drain);

describe("SelectList fuzzy-filter loop-phase breadcrumb", () => {
	it("wraps fuzzy-filter item reads in ui.select-filter and balances the stack", () => {
		const phases: Array<string | undefined> = [];
		const items: SelectItem[] = [
			{
				value: "alpha",
				get label() {
					phases.push(currentLoopPhase());
					return "Alpha";
				},
			},
			{ value: "beta", label: "Beta" },
			{ value: "gamma", label: "Gamma" },
		];
		const list = new SelectList(items, 2, {} as unknown as SelectListTheme);
		phases.length = 0;

		list.setFilter("al");

		expect(phases.length).toBeGreaterThan(0);
		expect(phases.every(phase => phase === "ui.select-filter")).toBe(true);
		expect(currentLoopPhase()).toBeUndefined();
	});

	it("does not breadcrumb an empty/whitespace filter", () => {
		const phases: Array<string | undefined> = [];
		const list = new SelectList(
			[
				{
					get value() {
						phases.push(currentLoopPhase());
						return "x";
					},
					label: "X",
				},
			],
			2,
			{} as unknown as SelectListTheme,
		);
		phases.length = 0;
		list.setFilter("   ");

		expect(currentLoopPhase()).toBeUndefined();
		expect(phases.length).toBeGreaterThan(0);
		expect(phases.every(phase => phase === undefined)).toBe(true);
	});
});
