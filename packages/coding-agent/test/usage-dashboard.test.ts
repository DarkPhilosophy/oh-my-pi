import { beforeAll, describe, expect, it } from "bun:test";
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import {
	buildHeatmapLayout,
	buildProviderCards,
	UsageDashboardComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/usage-dashboard";
import { createAccountMasker } from "@oh-my-pi/pi-coding-agent/modes/utils/usage-mask";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

beforeAll(async () => {
	const uiTheme = await getThemeByName("dark");
	if (!uiTheme) throw new Error("theme unavailable");
	setThemeInstance(uiTheme);
});

function day(day: string, cost: number, requests = 1): DailyActivityPoint {
	return { day, cost, requests, totalTokens: 0 };
}

function report(provider: string, email: string, limits: UsageReport["limits"]): UsageReport {
	return { provider, fetchedAt: Date.now(), limits, metadata: { email } };
}

function limit(
	provider: string,
	accountId: string,
	windowId: string,
	label: string,
	usedFraction: number,
	status: "ok" | "warning" | "exhausted",
	resetsAt?: number,
): UsageReport["limits"][number] {
	return {
		id: `${provider}:${accountId}:${windowId}`,
		label,
		scope: { provider, accountId, windowId },
		window: { id: windowId, label: windowId, resetsAt },
		amount: { usedFraction, unit: "percent" },
		status,
	};
}

describe("buildHeatmapLayout", () => {
	// 2026-08-31 is a Monday; keeps week alignment deterministic.
	const monday = new Date(2026, 7, 31, 12);

	it("aligns days Monday-first and marks future days null", () => {
		const layout = buildHeatmapLayout([day("2026-08-31", 5)], 2, monday);
		// Monday row, last column = today's week.
		expect(layout.cells[0][1]).toBe(4);
		// Tuesday..Sunday of the current week are in the future.
		for (let row = 1; row < 7; row++) expect(layout.cells[row][1]).toBeNull();
		// Previous week is fully in range but has no activity.
		for (let row = 0; row < 7; row++) expect(layout.cells[row][0]).toBe(0);
	});

	it("scales intensity by magnitude against the busiest day, not by rank", () => {
		const points = [
			day("2026-08-24", 100), // max → level 4
			day("2026-08-25", 30), // sqrt(0.3)≈0.55 → level 3
			day("2026-08-26", 6), // sqrt(0.06)≈0.24 → level 1
			day("2026-08-27", 0), // untouched → level 0
		];
		const layout = buildHeatmapLayout(points, 2, monday);
		expect(layout.cells[0][0]).toBe(4);
		expect(layout.cells[1][0]).toBe(3);
		expect(layout.cells[2][0]).toBe(1);
		expect(layout.cells[3][0]).toBe(0);
	});

	it("falls back to request counts when nothing in range is priced", () => {
		const layout = buildHeatmapLayout([day("2026-08-24", 0, 50), day("2026-08-25", 0, 3)], 2, monday);
		expect(layout.cells[0][0]).toBe(4);
		expect(layout.cells[1][0]).toBe(1);
		expect(layout.totalRequests).toBe(53);
	});

	it("labels a column when its week starts a new month", () => {
		// 6 weeks back from 2026-08-31 spans the July→August boundary.
		const layout = buildHeatmapLayout([], 6, monday);
		expect(layout.monthLabels[0]).toBe("Jul");
		expect(layout.monthLabels.filter(Boolean)).toEqual(["Jul", "Aug"]);
	});
});

describe("buildProviderCards", () => {
	const now = Date.now();

	it("averages a window across accounts instead of showing the worst account", () => {
		// One exhausted + one barely-used account: the classic report shows the
		// aggregate (~50% free), so the card must not read 0% free.
		const reports = [
			report("anthropic", "a@x.test", [limit("anthropic", "a", "7d", "Claude 7 Day", 1.0, "exhausted", now + 1000)]),
			report("anthropic", "b@x.test", [limit("anthropic", "b", "7d", "Claude 7 Day", 0.0, "ok", now + 99_000)]),
		];
		const cards = buildProviderCards(reports, now);
		expect(cards).toHaveLength(1);
		expect(cards[0].windows).toHaveLength(1);
		expect(cards[0].windows[0].fraction).toBeCloseTo(0.5);
		// Mixed healthy/exhausted accounts read as warning, not exhausted.
		expect(cards[0].windows[0].status).toBe("warning");
		// Reset countdown comes from the most-used account (when capacity returns).
		expect(cards[0].windows[0].resetMs).toBe(1000);
	});

	it("sorts pressured providers first and collapses untouched ones into idle", () => {
		const reports = [
			report("cursor", "c@x.test", [limit("cursor", "c", "monthly", "Cursor Models", 0.0, "ok")]),
			report("openai-codex", "o@x.test", [limit("openai-codex", "o", "7d", "7 days", 0.4, "ok")]),
			report("ollama-cloud", "l@x.test", []),
		];
		const cards = buildProviderCards(reports, now);
		expect(cards[0].provider).toBe("openai-codex");
		expect(cards[0].idle).toBe(false);
		const idle = cards.filter(card => card.idle).map(card => card.provider);
		expect(idle.sort()).toEqual(["cursor", "ollama-cloud"]);
		const unlimited = cards.find(card => card.provider === "ollama-cloud");
		expect(unlimited?.unlimited).toBe(true);
	});
});

describe("buildProviderCards split + privacy", () => {
	const now = Date.now();
	const reports = [
		report("anthropic", "alice@x.test", [limit("anthropic", "a", "7d", "Claude 7 Day", 1.0, "exhausted")]),
		report("anthropic", "alina@x.test", [limit("anthropic", "b", "7d", "Claude 7 Day", 0.0, "ok")]),
	];

	it("merge=false yields one card per account, each with its own fraction", () => {
		const cards = buildProviderCards(reports, now, { merge: false });
		expect(cards.map(card => card.account)).toEqual(["alice@x.test", "alina@x.test"]);
		expect(cards.map(card => card.windows[0].fraction)).toEqual([1, 0]);
	});

	it("masks split-card account labels and keeps colliding prefixes distinguishable", () => {
		const labels = reports.map(r => String(r.metadata?.email));
		const cards = buildProviderCards(reports, now, { merge: false, mask: createAccountMasker(labels, true) });
		const masked = cards.map(card => card.account);
		expect(masked.every(label => label !== undefined && !label.includes("@x.test"))).toBe(true);
		expect(new Set(masked).size).toBe(2);
	});
});

describe("UsageDashboardComponent session toggles", () => {
	function mount(maskAccountLabels: boolean, mergeAccounts: boolean) {
		const reports = [
			report("anthropic", "alice@x.test", [limit("anthropic", "a", "7d", "Claude 7 Day", 0.5, "ok")]),
			report("anthropic", "bob@x.test", [limit("anthropic", "b", "7d", "Claude 7 Day", 0.1, "ok")]),
		];
		return new UsageDashboardComponent({
			reports,
			renderDetail: () => "",
			createMasker: createAccountMasker,
			maskAccountLabels,
			mergeAccounts,
			labelPlacement: "moving",
			loadActivity: async () => {},
			requestRender: () => {},
			onClose: () => {},
		});
	}

	it("p and m flip privacy/merge only for the open overlay, starting from the settings values", () => {
		const dashboard = mount(true, true);
		expect(dashboard.viewState).toMatchObject({ maskAccountLabels: true, mergeAccounts: true });
		dashboard.handleInput("p");
		dashboard.handleInput("m");
		expect(dashboard.viewState).toMatchObject({ maskAccountLabels: false, mergeAccounts: false });
		const text = Bun.stripANSI(dashboard.render(120).join("\n"));
		expect(text).toContain("alice@x.test");
		expect(text).toContain("bob@x.test");
		// A fresh mount re-reads the (unchanged) settings: toggles never persisted.
		expect(mount(true, true).viewState).toMatchObject({ maskAccountLabels: true, mergeAccounts: true });
	});

	it("masks split cards while privacy is on", () => {
		const dashboard = mount(true, false);
		const text = Bun.stripANSI(dashboard.render(120).join("\n"));
		expect(text).not.toContain("alice@x.test");
		expect(text).toContain("***");
	});
});
