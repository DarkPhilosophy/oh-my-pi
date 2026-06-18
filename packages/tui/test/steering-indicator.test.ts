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

	it("flows a pulse wave whose crests move across frames", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const ind = new SteeringIndicator(ui, styles, "Steering", 6, 1);
		ind.setActive(true);
		// Snapshot the crest columns (● = wave peak) over successive frames. A crest
		// must be present each frame and the overall pattern must change frame-to-frame
		// (the pulse travels — it does not blink in place).
		const frames: string[] = [];
		let everHasCrest = true;
		for (let i = 0; i < 6; i++) {
			const frame = ind.render(80).join("");
			if (!frame.includes("●")) everHasCrest = false;
			frames.push(frame);
			vi.advanceTimersByTime(90);
		}
		expect(everHasCrest).toBe(true);
		expect(new Set(frames).size).toBeGreaterThan(1); // the wave actually moves
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
