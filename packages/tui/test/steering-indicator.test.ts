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

// Spotlight ramp, faint → bold.
const RAMP = ["·", "∙", "•", "●"] as const;
const HEAD = RAMP[RAMP.length - 1];
const FRAME_MS = 100;

describe("SteeringIndicator component", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("renders an idle titled top rule (corners + word, no spotlight) until setActive(true)", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const ind = new SteeringIndicator(ui, styles, border, "Steering");
		const idle = ind.render(80).join("");
		expect(idle).toContain("Steering");
		expect(idle.startsWith("╭")).toBe(true);
		expect(idle.endsWith("╮")).toBe(true);
		expect(idle).toContain("─");
		expect(idle).not.toContain(HEAD);
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
		expect(widths.size).toBe(1);
		expect([...widths][0]).toBe(80);
		ind.dispose();
	});

	it("sweeps the spotlight through the title without reaching the far border", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		// Mark bright cells so the head is trackable whether it lands on a rule
		// cell (`<●>`) or brightens a title letter (`<S>`).
		const marked = { dim: (s: string) => s, mid: (s: string) => s, bright: (s: string) => `<${s}>` };
		const ind = new SteeringIndicator(ui, marked, border, "Steering");
		ind.setActive(true);
		const width = 80;
		const headCols: number[] = [];
		let maxHeadCol = 0;
		for (let i = 0; i < 40; i++) {
			const line = ind.render(width).join("");
			// Exactly one bright span per frame — the head, as a glyph or letter.
			const matches = [...line.matchAll(/<([^>]*)>/g)];
			expect(matches.length).toBe(1);
			const before = line.slice(0, matches[0]?.index ?? 0);
			const head = [...before].length;
			headCols.push(head);
			maxHeadCol = Math.max(maxHeadCol, head);
			vi.advanceTimersByTime(FRAME_MS);
		}
		expect(maxHeadCol).toBeLessThan(width / 2);
		const maxHead = Math.max(...headCols);
		const minHead = Math.min(...headCols);
		expect(maxHead).toBeGreaterThan(minHead);
		const peak = headCols.indexOf(maxHead);
		expect(peak).toBeGreaterThan(0);
		expect(peak).toBeLessThan(headCols.length - 1);
		for (let i = 1; i <= peak; i++) expect(headCols[i]).toBeGreaterThanOrEqual(headCols[i - 1]);
		let descending = 0;
		for (let i = peak + 1; i < headCols.length; i++) {
			if (headCols[i] >= headCols[i - 1]) break;
			descending++;
		}
		expect(descending).toBeGreaterThanOrEqual(2);
		ind.dispose();
	});

	it("shows the full ramp on rule cells", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const ui = { requestComponentRender } as unknown as TUI;
		const ind = new SteeringIndicator(ui, styles, border, "Steer");
		ind.setActive(true);
		let sawFullRamp = false;
		for (let i = 0; i < 60; i++) {
			const line = ind.render(40).join("");
			if (RAMP.every(g => line.includes(g))) sawFullRamp = true;
			vi.advanceTimersByTime(FRAME_MS);
		}
		expect(sawFullRamp).toBe(true);
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
		vi.advanceTimersByTime(500);
		expect(requestComponentRender.mock.calls.length).toBe(after);
		expect(ind.render(80).join("")).not.toContain(HEAD);
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
		expect(() => ind.dispose()).not.toThrow();
	});
});
