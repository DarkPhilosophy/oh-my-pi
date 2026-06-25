import { afterEach, describe, expect, it, vi } from "bun:test";
import type { TUI } from "@oh-my-pi/pi-tui";
import { SteeringIndicator } from "@oh-my-pi/pi-tui/components/steering-indicator";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

// Identity stylers: assertions match plain glyphs and there is no ANSI to skip,
// so visibleWidth checks are exact.
const styles = { dim: (s: string) => s, mid: (s: string) => s, bright: (s: string) => s };
// Rounded box-drawing glyphs with identity paint (the caller injects these so the
// component stays theme-agnostic).
const border = { topLeft: "╭", topRight: "╮", horizontal: "─", paint: (s: string) => s };

const DOT = "●";
const FRAME_MS = 110;
const dotColumns = (line: string): number[] => [...line].flatMap((ch, idx) => (ch === DOT ? [idx] : []));

describe("SteeringIndicator component", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("renders an idle titled top rule (corners + word, no dots) until setActive(true)", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const ind = new SteeringIndicator(ui, styles, border, "Steering");
		const idle = ind.render(80).join("");
		expect(idle).toContain("Steering"); // inset title
		expect(idle.startsWith("╭")).toBe(true); // top-left corner
		expect(idle.endsWith("╮")).toBe(true); // top-right corner
		expect(idle).toContain("─"); // resting rule
		expect(idle).not.toContain(DOT); // no dots while idle
		// No timer is running, so advancing time produces no further renders.
		const before = requestComponentRender.mock.calls.length;
		vi.advanceTimersByTime(500);
		expect(requestComponentRender.mock.calls.length).toBe(before);
		ind.dispose();
	});

	it("spans exactly the render width every animated frame (no layout jitter)", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const ind = new SteeringIndicator(ui, styles, border, "Steering");
		ind.setActive(true);
		const widths = new Set<number>();
		for (let i = 0; i < 40; i++) {
			widths.add(visibleWidth(ind.render(80).join("")));
			vi.advanceTimersByTime(FRAME_MS);
		}
		expect(widths.size).toBe(1); // exactly one width seen across all frames
		expect([...widths][0]).toBe(80); // and it fills the full box width
		ind.dispose();
	});

	it("shows four equal dots clustered by the title and slides them without sweeping the rule", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const ind = new SteeringIndicator(ui, styles, border, "Steering");
		ind.setActive(true);
		const width = 80;
		const firsts: number[] = [];
		const counts = new Set<number>();
		const spans = new Set<number>();
		let maxDotCol = 0;
		for (let i = 0; i < 40; i++) {
			const cols = dotColumns(ind.render(width).join(""));
			counts.add(cols.length);
			const first = cols[0] ?? -1;
			const last = cols[cols.length - 1] ?? -1;
			firsts.push(first);
			spans.add(last - first);
			maxDotCol = Math.max(maxDotCol, last);
			vi.advanceTimersByTime(FRAME_MS);
		}
		// Always exactly four dots — no fading/growing comet that drops or adds dots.
		expect([...counts]).toEqual([4]);
		// The cluster keeps a constant span every frame: the dots never resize/spread.
		expect(spans.size).toBe(1);
		// Dots stay clustered near the title, never sweeping the whole rule.
		expect(maxDotCol).toBeLessThan(width / 2);
		// The cluster actually slides and bounces: it rises to a peak strictly inside
		// the frame sequence, then comes back.
		const maxFirst = Math.max(...firsts);
		const minFirst = Math.min(...firsts);
		expect(maxFirst).toBeGreaterThan(minFirst);
		const peak = firsts.indexOf(maxFirst);
		expect(peak).toBeGreaterThan(0);
		expect(peak).toBeLessThan(firsts.length - 1);
		ind.dispose();
	});

	it("setActive(false) halts the timer and returns to the idle rule", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const ind = new SteeringIndicator(ui, styles, border, "Steering");
		ind.setActive(true);
		ind.setActive(false);
		const after = requestComponentRender.mock.calls.length;
		vi.advanceTimersByTime(500); // far longer than the frame interval
		expect(requestComponentRender.mock.calls.length).toBe(after); // no further frames
		expect(ind.render(80).join("")).not.toContain(DOT); // back to idle
		ind.dispose();
	});

	it("dispose() stops the animation so no further renders are scheduled", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const ind = new SteeringIndicator(ui, styles, border, "Steering");
		ind.setActive(true);
		ind.dispose();
		const after = requestComponentRender.mock.calls.length;
		vi.advanceTimersByTime(500);
		expect(requestComponentRender.mock.calls.length).toBe(after);
		expect(() => ind.dispose()).not.toThrow(); // idempotent
	});
});
