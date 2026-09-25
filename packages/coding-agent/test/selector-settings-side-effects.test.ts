import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { cfgUsageMaskAccountLabels, cfgUsageMergeAccounts } from "@oh-my-pi/pi-coding-agent/secrets/settings";
import type { Component } from "@oh-my-pi/pi-tui";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("selector setting side effects", () => {
	it("keeps account labels masked when only the active session enables masking", async () => {
		const uiTheme = await getThemeByName("dark");
		if (!uiTheme) throw new Error("theme unavailable");
		setThemeInstance(uiTheme);
		cfgUsageMaskAccountLabels.override(Settings.instance, false);
		const scoped = Settings.isolated();
		cfgUsageMaskAccountLabels.override(scoped, true);
		cfgUsageMergeAccounts.override(scoped, false);
		let overlay: Component | undefined;
		const controller = new SelectorController({
			settings: scoped,
			session: { getUsageReportingModelSelectors: () => [] },
			ui: {
				showOverlay: (component: Component) => {
					overlay = component;
					return { hide() {} };
				},
				setFocus() {},
				requestRender() {},
			},
		} as unknown as InteractiveModeContext);
		controller.showUsageDashboard([
			{
				provider: "openai-codex",
				fetchedAt: Date.now(),
				metadata: { email: "private@example.test" },
				limits: [
					{
						id: "weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", accountId: "account", windowId: "weekly" },
						window: { id: "weekly", label: "Weekly" },
						amount: { usedFraction: 0.5, unit: "percent" },
						status: "ok",
					},
				],
			},
		]);
		const rendered = stripVTControlCharacters(overlay!.render(120).join("\n"));
		expect(rendered).not.toContain("private@example.test");
		overlay?.handleInput?.("p");
		expect(stripVTControlCharacters(overlay!.render(120).join("\n"))).toContain("private@example.test");
		overlay?.dispose?.();
	});
});
