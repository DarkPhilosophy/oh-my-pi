import { afterEach, describe, expect, it, vi } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { SteeringIndicator } from "@oh-my-pi/pi-tui/components/steering-indicator";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

// Identity stylers: assertions match plain glyphs and there is no ANSI to skip,
// so visibleWidth checks are exact.
const styles = { dim: (s: string) => s, mid: (s: string) => s, bright: (s: string) => s };

describe("SteeringIndicator component", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("renders the word idle (no comet) and stays inactive until setActive(true)", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const ind = new SteeringIndicator(ui, styles, "Steering", 6, 1);
		const idle = ind.render(80).join("");
		expect(idle).toContain("Steering");
		expect(idle).not.toContain("●"); // no comet head while idle
		// No timer is running, so advancing time produces no further renders.
		const before = requestComponentRender.mock.calls.length;
		vi.advanceTimersByTime(500);
		expect(requestComponentRender.mock.calls.length).toBe(before);
		ind.dispose();
	});

	it("keeps a constant visible width across every animated frame (no layout jitter)", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const ind = new SteeringIndicator(ui, styles, "Steering", 6, 1);
		ind.setActive(true);
		const widths = new Set<number>();
		for (let i = 0; i < 40; i++) {
			widths.add(visibleWidth(ind.render(80).join("")));
			vi.advanceTimersByTime(90);
		}
		expect(widths.size).toBe(1); // exactly one width seen across all frames
		ind.dispose();
	});

	it("sweeps a comet head left→right then bounces back right→left", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		// Mark the bright (comet-head) cell so we can locate it whether it sits on a
		// side particle (●) or on a word letter (which renders bright, not ●).
		const marked = { dim: (s: string) => s, mid: (s: string) => s, bright: (s: string) => `<${s}>` };
		// Small track so the sweep completes within a handful of frames.
		const ind = new SteeringIndicator(ui, marked, "Go", 3, 1);
		ind.setActive(true);
		// The comet head must be present every frame, and its column should advance
		// rightward, then (after the bounce) move leftward — one clear direction at a
		// time, never a static/symmetric pattern.
		const cols: number[] = [];
		for (let i = 0; i < 24; i++) {
			const col = ind.render(80).join("").indexOf("<");
			expect(col).toBeGreaterThanOrEqual(0); // a head is always present
			cols.push(col);
			vi.advanceTimersByTime(90);
		}
		// The head reaches a rightmost column then comes back: the max is strictly
		// inside the sequence (not at either end), proving a bounce occurred.
		const maxCol = Math.max(...cols);
		const peakIndex = cols.indexOf(maxCol);
		expect(peakIndex).toBeGreaterThan(0);
		expect(peakIndex).toBeLessThan(cols.length - 1);
		// One clear direction at a time: strictly rising up to the peak, strictly
		// falling immediately after it (no static or symmetric blinking).
		for (let i = 1; i <= peakIndex; i++) {
			expect(cols[i]).toBeGreaterThan(cols[i - 1]);
		}
		// Falling after the peak: strictly decreasing for the right→left run. Stop at
		// the first frame that is not lower than the previous one (the left bounce, where
		// the comet turns around) so we only assert the single descending sweep.
		let descendingSteps = 0;
		for (let i = peakIndex + 1; i < cols.length; i++) {
			if (cols[i] >= cols[i - 1]) break; // reached the left bounce → stop checking
			expect(cols[i]).toBeLessThan(cols[i - 1]);
			descendingSteps++;
		}
		expect(descendingSteps).toBeGreaterThanOrEqual(2); // a real right→left sweep, not a blip
		ind.dispose();
	});

	it("setActive(false) halts the timer and returns to the idle frame", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const ind = new SteeringIndicator(ui, styles, "Steering", 6, 1);
		ind.setActive(true);
		ind.setActive(false);
		const after = requestComponentRender.mock.calls.length;
		vi.advanceTimersByTime(500); // far longer than the frame interval
		expect(requestComponentRender.mock.calls.length).toBe(after); // no further frames
		expect(ind.render(80).join("")).not.toContain("●"); // back to idle
		ind.dispose();
	});

	it("dispose() stops the animation so no further renders are scheduled", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const ind = new SteeringIndicator(ui, styles, "Steering", 6, 1);
		ind.setActive(true);
		ind.dispose();
		const after = requestComponentRender.mock.calls.length;
		vi.advanceTimersByTime(500);
		expect(requestComponentRender.mock.calls.length).toBe(after);
		expect(() => ind.dispose()).not.toThrow(); // idempotent
	});
});
