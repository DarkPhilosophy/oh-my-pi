import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { WatchdogConfigDoc } from "../../../src/advisor/config";
import type { ModelRegistry } from "../../../src/config/model-registry";
import { Settings } from "../../../src/config/settings";
import { AdvisorConfigOverlayComponent } from "../../../src/modes/components/advisor-config";
import { getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";

describe("advisor config editor warnings and synthetic default row", () => {
	let settings: Settings;

	beforeAll(async () => {
		settings = await Settings.init({ inMemory: true });
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		setThemeInstance(theme);
	});

	const buildOverlay = (doc: WatchdogConfigDoc, onSave: (doc: WatchdogConfigDoc) => void) =>
		new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			doc,
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async (_scope, doc) => onSave(doc),
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);

	const clickSave = (overlay: AdvisorConfigOverlayComponent, scope: "project" | "user") => {
		const rows = overlay.render(100).map(Bun.stripANSI);
		const saveRows = rows.flatMap((row, index) => (row.slice(0, 35).includes("Save & apply") ? [index] : []));
		const row = saveRows[scope === "project" ? 0 : 1];
		if (row === undefined) throw new Error(`Missing ${scope} save row`);
		overlay.handleInput(`\x1b[<0;5;${row + 1}M`);
	};

	it("serializes project and global saves, then permits the blocked scope after completion", async () => {
		let finishFirst!: () => void;
		const firstSave = new Promise<void>(resolve => {
			finishFirst = resolve;
		});
		const saves: string[] = [];
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			{ advisors: [] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async scope => {
					saves.push(scope);
					if (saves.length === 1) await firstSave;
				},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);
		await Promise.resolve();
		await Promise.resolve();
		clickSave(overlay, "project");
		clickSave(overlay, "user");
		expect(saves).toEqual(["project"]);

		finishFirst();
		await Promise.resolve();
		await Promise.resolve();
		clickSave(overlay, "user");
		await Promise.resolve();
		expect(saves).toEqual(["project", "user"]);
	});

	it("releases the save guard after rejection without discarding pending edits", async () => {
		const attempts: Array<{ scope: string; doc: WatchdogConfigDoc }> = [];
		const notifications: string[] = [];
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			{ advisors: [{ name: "Reviewer" }] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async (scope, doc) => {
					attempts.push({ scope, doc: structuredClone(doc) });
					if (attempts.length === 1) throw new Error("disk full");
				},
				close: () => {},
				requestRender: () => {},
				notify: message => notifications.push(message),
			},
		);
		await Promise.resolve();
		await Promise.resolve();

		overlay.handleInput("\x1b[C");
		overlay.handleInput("\r");
		overlay.handleInput("\x1b[D");
		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		for (let i = 0; i < 5; i++) await Promise.resolve();

		expect(notifications).toContain("Advisor config: disk full");
		expect(Bun.stripANSI(overlay.render(100).join("\n"))).toContain("unsaved");

		clickSave(overlay, "project");
		await Promise.resolve();
		await Promise.resolve();
		expect(attempts).toEqual([
			{ scope: "project", doc: { advisors: [{ name: "Reviewer", enabled: false }] } },
			{ scope: "project", doc: { advisors: [{ name: "Reviewer", enabled: false }] } },
		]);
		expect(notifications).toContain("Saved Project · project advisors");
		expect(Bun.stripANSI(overlay.render(100).join("\n"))).not.toContain("unsaved");
	});

	it("still drops the untouched seeded default row on save", async () => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = buildOverlay({ advisors: [] }, doc => {
			saved = structuredClone(doc);
		});

		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r"); // Save & apply without touching the seeded row.
		await Promise.resolve();

		expect(saved?.advisors).toEqual([]);
	});

	it.each(["left", "click"])("preserves toggled tools across %s roster navigation", async navigation => {
		let saved: WatchdogConfigDoc | undefined;
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: ["read", "bash"] },
			"project",
			{ advisors: [{ name: "Reviewer", tools: [] }] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async (_scope, doc) => {
					saved = structuredClone(doc);
				},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
			},
		);
		overlay.handleInput("\x1b[C");
		let rows = overlay.render(100).map(Bun.stripANSI);
		const toolsRow = rows.findIndex(row => row.includes("Tools"));
		expect(toolsRow).toBeGreaterThan(0);
		overlay.handleInput(`\x1b[<0;60;${toolsRow + 1}M`);
		overlay.handleInput("\r");
		if (navigation === "left") overlay.handleInput("\x1b[D");
		else {
			rows = overlay.render(100).map(Bun.stripANSI);
			const advisorRow = rows.findIndex(row => row.slice(0, 35).includes("Reviewer"));
			overlay.handleInput(`\x1b[<0;5;${advisorRow + 1}M`);
		}
		overlay.handleInput("\x1b[C");
		overlay.handleInput("\x1b[D");
		rows = overlay.render(100).map(Bun.stripANSI);
		const saveRow = rows.findIndex(row => row.slice(0, 35).includes("Save & apply"));
		expect(saveRow).toBeGreaterThan(0);
		overlay.handleInput(`\x1b[<0;5;${saveRow + 1}M`);
		await Promise.resolve();
		expect(saved?.advisors[0].tools).toEqual(["read"]);
	});

	it("clears the saved scope's load warnings after normalization succeeds", async () => {
		const overlay = buildOverlay({ advisors: [], warnings: ["Malformed entry dropped"] }, () => {});
		expect(Bun.stripANSI(overlay.render(100).join("\n"))).toContain("Malformed entry dropped");
		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		await Bun.sleep(0);
		expect(Bun.stripANSI(overlay.render(100).join("\n"))).not.toContain("Malformed entry dropped");
	});

	it("maps a visible field click below wrapped warnings to that field", async () => {
		const overlay = buildOverlay(
			{ advisors: [{ name: "Reviewer" }], warnings: ["Malformed configuration entry was dropped. ".repeat(3)] },
			() => {},
		);
		await Bun.sleep(0);
		overlay.handleInput("\r");
		const rows = overlay.render(100).map(Bun.stripANSI);
		const nameRow = rows.findIndex(row => row.includes("Name") && row.includes("Reviewer"));
		expect(nameRow).toBeGreaterThan(3);
		overlay.handleInput(`\x1b[<0;60;${nameRow + 1}M`);
		expect(Bun.stripANSI(overlay.render(100).join("\n"))).toContain("Type a name");
	});

	it("surfaces sanitized warnings when the background scope finishes loading", async () => {
		const warnings: string[] = [];
		let pendingLoad: Promise<WatchdogConfigDoc> | undefined;
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			{ advisors: [{ name: "Reviewer" }] },
			{
				loadDoc: () => {
					pendingLoad = Promise.resolve({
						advisors: [],
						warnings: [
							`${path.join(os.homedir(), ".omp", "WATCHDOG.yml")}: advisor "\x1b[31mBad\tName\x1b[0m" dropped — boom`,
						],
					});
					return pendingLoad;
				},
				save: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
				warn: message => warnings.push(message),
			},
		);

		// Opening the project file shows nothing — the host owns initial warnings.
		expect(warnings).toEqual([]);

		// The overlay awaits the same promise; awaiting it here runs after its continuation.
		await pendingLoad;

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('advisor "Bad   Name" dropped');
		expect(warnings[0]).toContain("~/.omp/WATCHDOG.yml");
		expect(warnings[0]).not.toContain(path.join(os.homedir(), ".omp", "WATCHDOG.yml"));
		// The toast is chat-mounted behind the fullscreen overlay, so the warning
		// must also render inside the editor itself.
		const frame = overlay.render(100).join("\n");
		expect(frame).toContain('advisor "Bad   Name" dropped');
	});

	it("keeps a background scope read-only after loading fails", async () => {
		const notifications: string[] = [];
		const saves: Array<{ scope: string; doc: WatchdogConfigDoc }> = [];
		const projectDoc: WatchdogConfigDoc = { advisors: [{ name: "Reviewer" }] };
		const loadFailure = Promise.reject<WatchdogConfigDoc>(new Error("permission denied"));
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			projectDoc,
			{
				loadDoc: () => loadFailure,
				save: async (scope, doc) => {
					saves.push({ scope, doc: structuredClone(doc) });
				},
				close: () => {},
				requestRender: () => {},
				notify: message => notifications.push(message),
			},
		);

		await loadFailure.catch(() => {});
		await Promise.resolve();

		expect(notifications).toContain("Advisor config: permission denied");
		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		overlay.handleInput("\x1b[C");
		overlay.handleInput("\r");
		expect(saves).toEqual([]);

		for (let i = 0; i < 4; i++) overlay.handleInput("\x1b[A");
		overlay.handleInput("\x1b[C");
		overlay.handleInput("\r");
		overlay.handleInput("\x1b[D");
		for (let i = 0; i < 3; i++) overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		await Promise.resolve();

		expect(saves).toEqual([{ scope: "project", doc: { advisors: [{ name: "Reviewer", enabled: false }] } }]);
	});

	it("renders the opening file's warnings inside the overlay without re-notifying", () => {
		const warnings: string[] = [];
		const overlay = new AdvisorConfigOverlayComponent(
			{} as TUI,
			{ modelRegistry: {} as ModelRegistry, settings, scopedModels: [], availableToolNames: [] },
			"project",
			{ advisors: [{ name: "Good" }], warnings: ['/repo/WATCHDOG.yml: advisor "Bad" dropped — boom'] },
			{
				loadDoc: async () => ({ advisors: [] }),
				save: async () => {},
				close: () => {},
				requestRender: () => {},
				notify: () => {},
				warn: message => warnings.push(message),
			},
		);

		const frame = overlay.render(100).join("\n");
		expect(frame).toContain('advisor "Bad" dropped');
		expect(warnings).toEqual([]);
	});
});
