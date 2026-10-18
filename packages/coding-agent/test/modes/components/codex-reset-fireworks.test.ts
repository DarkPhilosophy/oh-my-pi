import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Component, OverlayHandle, OverlayOptions } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import {
	CodexResetFireworksController,
	detectCodexResetFireworks,
} from "@oh-my-pi/pi-tui/overlays/codex-reset-fireworks";
import { getThemeByName, setThemeInstance, type Theme, theme } from "@oh-my-pi/pi-tui/theme";

type CodexResetFireworksHost = ConstructorParameters<typeof CodexResetFireworksController>[0];

interface FakeHost {
	host: CodexResetFireworksHost;
	shown: Component[];
	options: OverlayOptions[];
	focused: Component[];
	requestRenderCount(): number;
	hiddenCount(): number;
}

function makeHost(rows = 24): FakeHost {
	const shown: Component[] = [];
	const options: OverlayOptions[] = [];
	const focused: Component[] = [];
	let renders = 0;
	let hidden = 0;
	const host: CodexResetFireworksHost = {
		ui: {
			showOverlay(component, nextOptions) {
				shown.push(component);
				options.push(nextOptions ?? {});
				return {
					hide() {
						hidden++;
					},
					setHidden() {},
					isHidden: () => false,
				} satisfies OverlayHandle;
			},
			setFocus(component) {
				focused.push(component);
			},
			requestRender() {
				renders++;
			},
			terminal: { rows },
		},
	};
	return {
		host,
		shown,
		options,
		focused,
		requestRenderCount: () => renders,
		hiddenCount: () => hidden,
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("Codex reset fireworks", () => {
	let priorTheme: Theme | undefined;
	beforeAll(async () => {
		priorTheme = theme;
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		setThemeInstance(loaded);
	});

	afterAll(() => {
		if (priorTheme) setThemeInstance(priorTheme);
	});

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("detects an unscheduled weekly reset and prioritizes newly banked resets", () => {
		const previous = {
			observedAt: 1_000,
			sevenDay: { percent: 42, resetsAt: 10_000 },
			savedResets: 0,
		};
		expect(
			detectCodexResetFireworks(previous, {
				observedAt: 2_000,
				sevenDay: { percent: 2, resetsAt: 20_000 },
				savedResets: 0,
			}),
		).toEqual({ kind: "unscheduled-weekly-reset" });
		expect(
			detectCodexResetFireworks(previous, {
				observedAt: 2_000,
				sevenDay: { percent: 0, resetsAt: 20_000 },
				savedResets: 2,
			}),
		).toEqual({ kind: "saved-reset-banked", added: 2, available: 2 });
	});
	it("suppresses an early weekly drop when a saved reset was redeemed", () => {
		expect(
			detectCodexResetFireworks(
				{
					observedAt: 1_000,
					sevenDay: { percent: 42, resetsAt: 10_000 },
					savedResets: 1,
				},
				{
					observedAt: 2_000,
					sevenDay: { percent: 0, resetsAt: 10_000 },
					savedResets: 0,
				},
			),
		).toBeUndefined();
	});

	it("suppresses a weekly decrease when the quota deadline did not advance", () => {
		expect(
			detectCodexResetFireworks(
				{
					observedAt: 1_000,
					sevenDay: { percent: 42, resetsAt: 10_000 },
					savedResets: 0,
				},
				{
					observedAt: 2_000,
					sevenDay: { percent: 41, resetsAt: 10_000 },
					savedResets: 0,
				},
			),
		).toBeUndefined();
	});

	it("suppresses a weekly transition observed at its scheduled reset deadline", () => {
		expect(
			detectCodexResetFireworks(
				{
					observedAt: 1_000,
					sevenDay: { percent: 42, resetsAt: 2_000 },
				},
				{
					observedAt: 2_000,
					sevenDay: { percent: 0, resetsAt: 10_000 },
				},
			),
		).toBeUndefined();
	});

	it("requires the prior weekly reset deadline to establish that a reset was unscheduled", () => {
		expect(
			detectCodexResetFireworks(
				{
					observedAt: 1_000,
					sevenDay: { percent: 42 },
				},
				{
					observedAt: 2_000,
					sevenDay: { percent: 0 },
				},
			),
		).toBeUndefined();
	});

	it("requires the provider fetch timestamp to establish that a reset was early", () => {
		expect(
			detectCodexResetFireworks(
				{
					observedAt: 1_000,
					sevenDay: { percent: 42, resetsAt: 10_000 },
				},
				{
					sevenDay: { percent: 0, resetsAt: 10_000 },
				},
			),
		).toBeUndefined();
	});

	it("renders distinct copy for usage-window and saved-reset celebrations", () => {
		const usage = makeHost();
		const usageController = new CodexResetFireworksController(usage.host);
		usageController.show({ kind: "unscheduled-weekly-reset" });
		const usageText = usage.shown[0]?.render(80).map(stripVTControlCharacters).join("\n") ?? "";

		const saved = makeHost();
		const savedController = new CodexResetFireworksController(saved.host);
		savedController.show({ kind: "saved-reset-banked", added: 1, available: 3 });
		const savedText = saved.shown[0]?.render(80).map(stripVTControlCharacters).join("\n") ?? "";

		expect(usageText).toContain("O P E N A I   R E S E T");
		expect(usageText).toContain("Weekly usage cleared early");
		expect(savedText).toContain("S A V E D   R E S E T");
		expect(savedText).toContain("New reset banked · 3 available");
		expect(savedText).not.toContain("Weekly usage cleared early");

		usageController.dispose();
		savedController.dispose();
	});

	it("shows a non-modal centered toast that leaves focus below and dismisses itself", async () => {
		const fake = makeHost(24);
		const controller = new CodexResetFireworksController(fake.host);
		expect(controller.show({ kind: "unscheduled-weekly-reset" })).toBe(true);
		expect(controller.show({ kind: "saved-reset-banked", added: 1, available: 1 })).toBe(false);
		expect(fake.shown).toHaveLength(1);
		expect(fake.focused).toHaveLength(0);
		const rows = fake.shown[0]!.render(80).map(stripVTControlCharacters);
		expect(rows.length).toBeLessThan(24);
		expect(rows[0]!.startsWith("╭")).toBe(true);
		expect(rows.at(-1)!.startsWith("╰")).toBe(true);

		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		expect(fake.hiddenCount()).toBe(1);

		const second = controller.show({ kind: "unscheduled-weekly-reset" });
		expect(second).toBe(true);
		expect(fake.shown).toHaveLength(2);
		fake.shown[1]?.handleInput?.("\x1b");
		await flushMicrotasks();
		expect(fake.hiddenCount()).toBe(2);
		controller.dispose();
	});
});
