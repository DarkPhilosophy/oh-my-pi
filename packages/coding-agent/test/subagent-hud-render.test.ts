/**
 * Contract: the anchored subagent HUD (rendered above the editor, next to the
 * Todos block) lists exactly the running *detached* subagents as paired ID and
 * activity rows and yields no output once nothing qualifies, so the block
 * self-clears. Sync task spawns and eval `agent()` spawns are excluded:
 * their progress is already rendered inline (tool block / eval cell).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetHangulCompatibilityJamoWidthForTests, setHangulCompatibilityJamoWidth } from "@oh-my-pi/pi-tui";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-tui/prompt/composer";
import {
	InteractiveMode,
	layoutPinnedHud,
	nextSubagentPreviewTickMs,
	renderSubagentHudLines,
	SubagentHudComponent,
} from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { type ObservableSession, SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { loadTheme } from "@oh-my-pi/pi-tui/theme/loader";
import { initTheme, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgDisplaySubagentLivePreview } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { cfgTaskShowResolvedModelBadge } from "@oh-my-pi/pi-coding-agent/task/settings";

function makeSession(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeLifecycle(id: string, index: number, description: string, detached?: boolean): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId: "tool-call",
		detached,
	};
}

function makeProgressPayload(
	id: string,
	index: number,
	description: string,
	detached?: boolean,
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: description,
		parentToolCallId: "tool-call",
		detached,
		progress: makeProgress({ id, index, description, task: description }),
	};
}

function render(sessions: ObservableSession[], columns = 120, livePreview = false): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, columns, false, livePreview).join("\n"));
}

/** The fork's tool-row assertions run with the live preview enabled. */
function renderWithPreview(sessions: ObservableSession[], columns = 120): string {
	return render(sessions, columns, true);
}

function expectSameRow(output: string, ...contents: string[]): void {
	expect(output.split("\n").some(line => contents.every(content => line.includes(content)))).toBe(true);
}

function expectDescriptionNotEchoed(output: string, id: string, description: string): void {
	const row = output.split("\n").find(line => line.includes(id));
	expect(row).toBeDefined();
	const normalized = row!.toLowerCase();
	const needle = description.toLowerCase();
	expect(normalized.split(needle)).toHaveLength(2);
}

describe("subagent HUD lines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	describe("model badges", () => {
		beforeEach(async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { "task.showResolvedModelBadge": true } });
		});

		afterEach(() => {
			resetSettingsForTest();
		});

		it("places thinking, model and optional advisor before the detached agent name", () => {
			const session = makeSession({
				id: "BadgeWorker",
				agent: "scout",
				description: "Inspect rendering",
				progress: makeProgress({
					id: "BadgeWorker",
					resolvedModel: "openai/gpt-5:high",
					resolvedModelIdentity: "openai/gpt-5",
					resolvedThinkingLevel: ThinkingLevel.High,
					advisor: true,
				}),
			});
			const out = render([session]);
			expect(out).toContain(`${theme.thinking.high.split(" ")[0]} openai/gpt-5 ${theme.icon.advisor} BadgeWorker`);
			expect(out).toContain(`BadgeWorker ${theme.format.bracketLeft}scout${theme.format.bracketRight}`);
			expect(out).toContain(": Inspect rendering");

			session.progress = makeProgress({
				id: "BadgeWorker",
				resolvedModel: "openai/gpt-5:high",
				resolvedModelIdentity: "openai/gpt-5",
				resolvedThinkingLevel: ThinkingLevel.High,
				advisor: false,
			});
			const withoutAdvisor = render([session]);
			expect(withoutAdvisor).toContain("openai/gpt-5 BadgeWorker");
			expect(withoutAdvisor).not.toContain(theme.icon.advisor);
		});

		it("keeps metadata hidden when disabled or settings have not initialized", () => {
			const sessions = [
				makeSession({
					id: "HiddenBadge",
					description: "Inspect rendering",
					progress: makeProgress({
						id: "HiddenBadge",
						resolvedModel: "openai/gpt-5:high",
						resolvedModelIdentity: "openai/gpt-5",
						resolvedThinkingLevel: ThinkingLevel.High,
						advisor: true,
					}),
				}),
			];
			cfgTaskShowResolvedModelBadge.override(Settings.instance, false);
			const disabled = render(sessions);
			expect(disabled).toContain(`${theme.status.done} HiddenBadge: Inspect rendering`);
			expect(disabled).not.toContain("openai/gpt-5");
			expect(disabled).not.toContain(theme.icon.advisor);

			resetSettingsForTest();
			expect(render(sessions)).toBe(disabled);
		});

		it("preserves model identity and the agent name while fitting descriptions and task previews", () => {
			const metadata = {
				resolvedModel: `provider/${"shared-prefix-".repeat(8)}variant-z:high`,
				resolvedModelIdentity: `provider/${"shared-prefix-".repeat(8)}variant-z`,
				resolvedThinkingLevel: ThinkingLevel.High,
				advisor: true,
			};
			const sessions = [
				makeSession({
					id: "Description",
					description: "Inspect rendering ".repeat(20),
					progress: makeProgress({ id: "Description", ...metadata }),
				}),
				makeSession({
					id: "TaskPreview",
					progress: makeProgress({ id: "TaskPreview", task: "Inspect rendering ".repeat(20), ...metadata }),
				}),
			];
			const lines = render(sessions, 60).split("\n");
			for (const id of ["Description", "TaskPreview"]) {
				const row = lines.find(line => line.includes(id))!;
				expect(row).toContain(`variant-z ${theme.icon.advisor} ${id}`);
				expect(row.indexOf("variant-z")).toBeLessThan(row.indexOf(id));
				expect(row).not.toContain(":high");
			}
			for (const line of lines) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
			}
		});

		it("reserves custom tree prefixes, outer indent and roles before optional details", () => {
			const priorTree = Object.getOwnPropertyDescriptor(theme, "tree");
			try {
				Object.defineProperty(theme, "tree", {
					configurable: true,
					value: { ...theme.tree, branch: "界├", last: "界界└", vertical: "界界│" },
				});
				const sessions = [
					makeSession({
						id: `LongWorker${"界".repeat(30)}`,
						agent: `custom-role-${"extended-".repeat(10)}`,
						description: "Every available column ".repeat(10),
						progress: makeProgress({ id: "LongWorker", resolvedModelIdentity: "provider/model", advisor: true }),
					}),
					makeSession({ id: "ShortWorker", agent: "scout", description: "Every available column ".repeat(10) }),
				];
				for (const enabled of [true, false]) {
					cfgTaskShowResolvedModelBadge.override(Settings.instance, enabled);
					for (const width of [40, 120, 40]) {
						const rows = render(sessions, width).split("\n");
						expect(rows.find(row => row.includes("LongWorker"))).toStartWith(" 界├ ");
						expect(rows.find(row => row.includes("ShortWorker"))).toStartWith(" 界界└ ");
						for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width);
						expect(rows.find(row => row.includes("LongWorker"))).toContain("LongWorker");
						expect(rows.find(row => row.includes("ShortWorker"))).toContain(
							`${theme.format.bracketLeft}scout${theme.format.bracketRight}`,
						);
					}
				}
			} finally {
				if (priorTree) Object.defineProperty(theme, "tree", priorTree);
				else Reflect.deleteProperty(theme, "tree");
			}
		});

		it("preserves a legacy selector without inventing a thinking glyph", () => {
			const out = render([
				makeSession({
					id: "LegacyWorker",
					progress: makeProgress({ id: "LegacyWorker", resolvedModel: "custom/model:high" }),
				}),
			]);
			expect(out).toContain(`${theme.status.done} custom/model:high LegacyWorker`);
			expect(out).not.toContain(theme.thinking.high.split(" ")[0]);
		});
	});

	it("renders running subagents as Id: description under a Subagents header", () => {
		const out = render([
			makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" }),
			makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
		]);
		expect(out).toContain("Subagents");
		expectSameRow(out, "AuthLoader", "Refactoring the auth flow");
		expectSameRow(out, "SchemaMigrator", "Migrating the users table");
	});

	it("keeps the last finished tool visible until the next tool starts", () => {
		const active = makeSession({
			id: "Reader",
			description: "Inspecting renderer behavior",
			progress: makeProgress({
				id: "Reader",
				resolvedModel: "openai/gpt-5.6-sol",
				lastIntent: "Inspecting renderer behavior",
				currentTool: "read",
				currentToolArgs: "packages/coding-agent/src/modes/interactive-mode.ts",
			}),
		});
		const withoutModel = renderSubagentHudLines([active], 40, false, true, false).join("\n");
		expect(withoutModel).not.toContain("openai/gpt-5.6-sol");
		const activeLines = renderSubagentHudLines([active], 40, false, true, true);
		const activeText = Bun.stripANSI(activeLines.join("\n"));
		expectSameRow(
			Bun.stripANSI(renderSubagentHudLines([active], 120, false, true, true).join("\n")),
			"Reader",
			"openai/gpt-5.6-sol",
			"Inspecting renderer behavior",
		);
		expectSameRow(activeText, "read: packages/");
		for (const row of activeLines.flatMap(line => line.split("\n")))
			expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(40);
		const settled = makeSession({
			...active,
			progress: makeProgress({
				id: "Reader",
				lastIntent: "Inspecting renderer behavior",
				recentTools: [{ tool: "read", args: "package.json", endMs: Date.now() }],
			}),
		});
		const settledText = Bun.stripANSI(renderSubagentHudLines([settled], 40, false, true, true).join("\n"));
		expectSameRow(settledText, theme.symbol("status.success"), "read: package.json");
		const next = makeSession({
			...settled,
			progress: makeProgress({
				id: "Reader",
				currentTool: "grep",
				currentToolArgs: "symbol",
				recentTools: settled.progress!.recentTools,
			}),
		});
		const nextText = renderWithPreview([next]);
		expect(nextText).toContain("grep: symbol");
		expect(nextText).not.toContain("read:");
	});

	it("retains failure status and path privacy in the completed tool row", () => {
		const homePath = path.join(process.env.HOME!, "private-project", "missing.ts");
		const text = renderWithPreview([
			makeSession({
				id: "Reader",
				progress: makeProgress({
					id: "Reader",
					recentTools: [{ tool: "read", args: homePath, argsKey: "path", isError: true, endMs: 1 }],
				}),
			}),
		]);
		expectSameRow(text, theme.symbol("status.error"), "read: ~/private-project/missing.ts");
		expect(text).not.toContain(homePath);
	});

	it("formats selected tool arguments by semantic key without changing raw command text", () => {
		const homePath = path.join(process.env.HOME!, "private-project", "secret.ts");
		const readOut = renderWithPreview([
			makeSession({
				id: "Reader",
				progress: makeProgress({
					id: "Reader",
					currentTool: "ast_grep",
					currentToolArgs: homePath,
					currentToolArgsKey: "path",
				}),
			}),
		]);
		expect(readOut).toContain("ast_grep: ~/private-project/secret.ts");
		const patternOut = renderWithPreview([
			makeSession({
				id: "Searcher",
				progress: makeProgress({
					id: "Searcher",
					currentTool: "grep",
					currentToolArgs: homePath,
					currentToolArgsKey: "pattern",
				}),
			}),
		]);
		expect(patternOut).toContain(`grep: ${homePath}`);
		const command = `MODE=check cat "${homePath}"`;
		const bashOut = renderWithPreview([
			makeSession({
				id: "Runner",
				progress: makeProgress({
					id: "Runner",
					currentTool: "bash",
					currentToolArgs: command,
					currentToolArgsKey: "command",
				}),
			}),
		]);
		expect(bashOut).toContain('bash: MODE=check cat "~/private-project/');
		expect(bashOut).not.toContain(homePath);
	});

	it("uses configured status glyphs for completed edits without hiding file locations", async () => {
		const previousTheme = theme;
		try {
			for (const preset of ["ascii", "nerd"] as const) {
				setThemeInstance(await loadTheme("dark", { symbolPresetOverride: preset }));
				for (const isError of [false, true]) {
					const text = renderWithPreview([
						makeSession({
							id: "Editor",
							progress: makeProgress({
								id: "Editor",
								recentTools: [
									{ tool: "edit", args: "src/one.ts, src/two.ts", argsKey: "path", isError, endMs: 1 },
								],
							}),
						}),
					]);
					expectSameRow(
						text,
						theme.symbol(isError ? "status.error" : "status.success"),
						"edit: src/one.ts, src/two.ts",
					);
				}
			}
		} finally {
			setThemeInstance(previousTheme);
		}
	});

	it("shortens compound path tokens without rewriting unrelated absolute paths", () => {
		const home = process.env.HOME!;
		const args = `src/**/*.ts; ${home}/private/*.ts; /mnt${home}/keep.ts`;
		const text = renderWithPreview(
			[
				makeSession({
					id: "Locator",
					progress: makeProgress({
						id: "Locator",
						currentTool: "glob",
						currentToolArgs: args,
						currentToolArgsKey: "path",
					}),
				}),
			],
			240,
		);
		// The preview truncates a long detail; the visible prefix shows the home path shortened and the
		// unrelated absolute path left alone.
		expect(text).toContain("glob: src/**/*.ts; ~/private/*.ts; /mnt/");
	});

	it("shortens a home-directory entry in colon-separated command paths", () => {
		const text = renderWithPreview([
			makeSession({
				id: "Runner",
				progress: makeProgress({
					id: "Runner",
					currentTool: "bash",
					currentToolArgs: `PYTHONPATH=${process.env.HOME!}:/opt/lib python`,
					currentToolArgsKey: "command",
				}),
			}),
		]);
		expect(text).toContain("PYTHONPATH=~:/opt/lib python");
	});

	it("shortens home paths adjoining shell redirections", () => {
		const text = renderWithPreview(
			[
				makeSession({
					id: "Runner",
					progress: makeProgress({
						id: "Runner",
						currentTool: "bash",
						currentToolArgsKey: "command",
						currentToolArgs: `cat <${process.env.HOME!}/in >>${process.env.HOME!}/out`,
					}),
				}),
			],
			240,
		);
		expect(text).toContain("cat <~/in >>~/out");
		expect(text).not.toContain(process.env.HOME!);
	});

	it("preserves model revision and effort in a roomy HUD badge", () => {
		const selector = "anthropic/claude-sonnet-4-20250514:high";
		const text = Bun.stripANSI(
			renderSubagentHudLines(
				[
					makeSession({
						id: "Worker",
						progress: makeProgress({ id: "Worker", resolvedModel: selector }),
					}),
				],
				160,
				false,
				false,
				true,
			).join("\n"),
		);
		expect(text).toContain("anthropic/");
		expect(text).toContain("20250514:high");
	});

	it("shortens home paths in live activity labels", () => {
		const homePath = path.join(process.env.HOME!, "private-project", "source.ts");
		const text = renderWithPreview([
			makeSession({
				id: "Reader",
				progress: makeProgress({ id: "Reader", lastIntent: `${homePath} checking imports` }),
			}),
		]);
		expect(text).toContain("~/private-project/source.ts checking imports");
		expect(text).not.toContain(homePath);
	});

	it("shows a non-default role badge and hides descriptions that only echo the id", () => {
		const withRole = render([
			makeSession({
				id: "AuthLoader",
				agent: "scout",
				description: "Refactor the auth flow",
			}),
		]);
		expect(withRole).toContain("AuthLoader");
		expect(withRole).toMatch(/AuthLoader.*scout/);
		expect(withRole).toContain("Refactor the auth flow");

		const echoed = render([
			makeSession({
				id: "AuthLoader",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(echoed).toContain("AuthLoader");
		expect(echoed).toMatch(/AuthLoader.*scout/);
		expectDescriptionNotEchoed(echoed, "AuthLoader", "AuthLoader");

		const collision = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(collision).toContain("AuthLoader-3");
		expect(collision).toMatch(/AuthLoader-3.*scout/);
		expectDescriptionNotEchoed(collision, "AuthLoader-3", "AuthLoader");

		const mixedCase = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "authloader",
			}),
		]);
		expect(mixedCase).toContain("AuthLoader-3");
		expectDescriptionNotEchoed(mixedCase, "AuthLoader-3", "authloader");

		const defaultWorker = render([
			makeSession({ id: "SchemaMigrator", agent: "task", description: "Migrate users" }),
		]);
		expectSameRow(defaultWorker, "SchemaMigrator", "Migrate users");
		expect(defaultWorker).not.toMatch(/SchemaMigrator.*task/);
	});

	it("only shows active subagents and clears once everything finished", () => {
		const finishedStates = ["completed", "failed", "aborted"] as const;
		const sessions: ObservableSession[] = [
			{ id: "main", kind: "main", label: "Main Session", status: "active", lastUpdate: Date.now() },
			...finishedStates.map(status => makeSession({ id: `Done-${status}`, status, description: "old work" })),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);

		const out = render([...sessions, makeSession({ id: "StillRunning", description: "live work" })]);
		expectSameRow(out, "StillRunning", "live work");
		expect(out).not.toContain("Done-");
		expect(out).not.toContain("Main Session");
	});

	it("falls back to the description and task carried by progress snapshots", () => {
		const fromProgressDesc = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", description: "From progress" }) }),
		]);
		expectSameRow(fromProgressDesc, "Worker", "From progress");

		const fromTask = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", task: "Investigate flaky CI on macOS" }) }),
		]);
		expectSameRow(fromTask, "Worker", "Investigate flaky CI on macOS");

		const generatedOverWrappedTask = render([
			makeSession({
				id: "Worker",
				description: "Generated activity label",
				progress: makeProgress({
					id: "Worker",
					description: "Generated progress label",
					assignment: "Inspect HUD precedence",
					task: "Complete assignment thoroughly:\n\n# Target\nHUD",
				}),
			}),
		]);
		expectSameRow(generatedOverWrappedTask, "Worker", "Generated progress label");
		expect(generatedOverWrappedTask).not.toContain("Complete assignment thoroughly");

		const assignmentAfterHandleEcho = render([
			makeSession({
				id: "Worker",
				progress: makeProgress({
					id: "Worker",
					lastIntent: "Worker",
					description: "worker",
					assignment: "Inspect HUD fallback",
					task: "Complete assignment thoroughly",
				}),
			}),
		]);
		expectSameRow(assignmentAfterHandleEcho, "Worker", "Inspect HUD fallback");
		expect(assignmentAfterHandleEcho).not.toContain("Complete assignment thoroughly");

		const multiLineTask = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				progress: makeProgress({
					id: "ReviewShell",
					agent: "scout",
					task: "Complete assignment thoroughly:\n\n# Target\nFiles: src/foo.ts",
				}),
			}),
		]);
		expect(multiLineTask).toContain("ReviewShell");
		expectSameRow(multiLineTask, "ReviewShell", "Complete assignment thoroughly:", "# Target");
		expect(multiLineTask).not.toContain("\n# Target");

		const multiLineDesc = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				description: "First line\n\nSecond line",
			}),
		]);
		expect(multiLineDesc).toContain("ReviewShell");
		expectSameRow(multiLineDesc, "ReviewShell", "First line", "Second line");
		expect(multiLineDesc).not.toContain("\nSecond line");
	});
	it("hides non-detached spawns: sync task calls and eval agent() helpers", () => {
		const sessions = [
			makeSession({ id: "SyncSpawn", description: "inline task work", detached: false }),
			makeSession({ id: "EvalSpawn", description: "eval cell work", detached: undefined }),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);

		const out = render([...sessions, makeSession({ id: "BackgroundSpawn", description: "detached work" })]);
		expectSameRow(out, "BackgroundSpawn", "detached work");
		expect(out).not.toContain("SyncSpawn");
		expect(out).not.toContain("EvalSpawn");
	});
	it("threads the detached flag from lifecycle and progress payloads", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Inline", 1, "sync work"));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("FromProgress", 2, "background work", true));

		const out = render(registry.getSessions());
		expectSameRow(out, "Detached", "background work");
		expectSameRow(out, "FromProgress", "background work");
		expect(out).not.toContain("Inline");
	});

	it("renders nested ids as a breadcrumb and truncates long descriptions to the viewport", () => {
		const out = render([makeSession({ id: "Anna.Bob", description: `start ${"x".repeat(300)} end` })], 60);
		expectSameRow(out, "Anna>Bob", "start");
		expect(out).not.toContain("end");
		for (const line of out.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("dedupes frames dual-published on the session bus and the shared bus", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const kinds: string[] = [];
		registry.onChange(kind => kinds.push(kind));
		const payload = makeLifecycle("DualPublished", 0, "dual-published frame");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		expect(kinds).toEqual(["lifecycle"]);
		expect(registry.getActiveSubagentCount()).toBe(1);
		registry.dispose();
	});

	it("keeps subagent registry order stable while progress arrives out of order", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const activeIds = () =>
			registry
				.getSessions()
				.filter(session => session.kind === "subagent" && session.status === "active")
				.map(session => session.id);

		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("SelectorSurfaces", 0, "Map model-selector resolution surfaces"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);
	});

	it("renders every live agent when expanded, with a collapse row", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const out = Bun.stripANSI(renderSubagentHudLines(active, 120, true, true).join("\n"));

		for (const session of active) {
			expect(out).toContain(`${session.id}: ${session.description}`);
		}
		expect(out).not.toContain("more running");
		expect(out).toContain("show less");
	});

	it("renders the first eight active detached subagents and summarizes the rest", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const out = render(active, 120);
		for (const session of active.slice(0, 8)) {
			expectSameRow(out, session.id, session.description!);
		}
		for (const session of active.slice(8)) {
			expect(out.split("\n").some(line => line.includes(session.id) && line.includes(session.description!))).toBe(
				false,
			);
		}
		expect(out).toContain("2 more — expand");
	});
	describe("live preview", () => {
		it("shows the current tool call only when enabled", () => {
			const sessions = [
				makeSession({
					id: "AuthLoader",
					description: "Refactoring the auth flow",
					progress: makeProgress({
						id: "AuthLoader",
						currentTool: "read",
						currentToolArgs: "src/auth.ts:50-100",
					}),
				}),
			];
			expect(render(sessions)).not.toContain("read: src/auth.ts:50-100");
			const out = render(sessions, 120, true);
			expect(out).toContain("AuthLoader: Refactoring the auth flow");
			expect(out).toContain("read: src/auth.ts:50-100");
		});

		it("falls back to the most recent tool when idle between calls", () => {
			const out = render(
				[
					makeSession({
						id: "Worker",
						progress: makeProgress({
							id: "Worker",
							recentTools: [{ tool: "grep", args: "renderSubagentHudLines", endMs: Date.now() }],
						}),
					}),
				],
				120,
				true,
			);
			expect(out).toContain("grep: renderSubagentHudLines");
		});

		it("adds an elapsed marker to long-running calls and stays within the viewport", () => {
			const columns = 120;
			const out = render(
				[
					makeSession({
						id: "Builder",
						progress: makeProgress({
							id: "Builder",
							currentTool: "bash",
							currentToolArgs: "npm test",
							currentToolStartMs: Date.now() - 10_000,
						}),
					}),
				],
				columns,
				true,
			);
			const toolRow = out.split("\n").find(line => line.includes("bash: npm test"));
			expect(toolRow).toMatch(/\d+s$/);
			for (const line of out.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
			}
		});

		it("shortens long tool details to the viewport", () => {
			const columns = 60;
			const out = render(
				[
					makeSession({
						id: "Reader",
						progress: makeProgress({
							id: "Reader",
							currentTool: "read",
							currentToolArgs: "x".repeat(300),
							currentToolStartMs: Date.now() - 10_000,
						}),
					}),
				],
				columns,
				true,
			);
			expect(out).toContain("read: xxxxxxxx");
			for (const line of out.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
			}
		});
		it("shortens home-directory paths in preview details", () => {
			const homeFile = `${os.homedir()}/.ssh/config`;
			const out = render(
				[
					makeSession({
						id: "Reader",
						progress: makeProgress({
							id: "Reader",
							currentTool: "read",
							currentToolArgs: `cat ${homeFile}`,
						}),
					}),
				],
				120,
				true,
			);
			expect(out).toContain("cat ~/.ssh/config");
			expect(out).not.toContain(os.homedir());
		});

		it("shortens a path argument by its key but keeps a literal search pattern as written", () => {
			const homeFile = `${os.homedir()}/.ssh/config`;
			const preview = (key: string) =>
				render(
					[
						makeSession({
							id: "Reader",
							progress: makeProgress({
								id: "Reader",
								currentTool: "grep",
								currentToolArgs: homeFile,
								currentToolArgsKey: key,
							}),
						}),
					],
					200,
					true,
				);
			expect(preview("path")).toContain("~/.ssh/config");
			expect(preview("path")).not.toContain(os.homedir());
			// A search pattern that names a home path must still show what was searched.
			expect(preview("pattern")).toContain(homeFile);
		});

		it("marks the last completed call with how it ended while idle between calls", () => {
			const rowFor = (isError: boolean) =>
				render(
					[
						makeSession({
							id: "Worker",
							progress: makeProgress({
								id: "Worker",
								recentTools: [{ tool: "read", args: "a.ts", argsKey: "path", isError, endMs: Date.now() }],
							}),
						}),
					],
					120,
					true,
				)
					.split("\n")
					.find(line => line.includes("read: a.ts"));
			const success = Bun.stripANSI(theme.styledSymbol("status.success", "success"));
			const error = Bun.stripANSI(theme.styledSymbol("status.error", "error"));
			expect(rowFor(false)).toContain(`${success} read: a.ts`);
			expect(rowFor(true)).toContain(`${error} read: a.ts`);
			expect(rowFor(false)).not.toContain(error);
		});

		it("keeps the elapsed marker with a very long tool name at a narrow width", () => {
			const columns = 40;
			const out = render(
				[
					makeSession({
						id: "Mcp",
						progress: makeProgress({
							id: "Mcp",
							currentTool: `mcp__tool_${"x".repeat(120)}`,
							currentToolArgs: "some detail that cannot fit",
							currentToolStartMs: Date.now() - 20_000,
						}),
					}),
				],
				columns,
				true,
			);
			const toolRow = out.split("\n").find(line => line.includes("mcp__tool_"));
			expect(toolRow).toBeDefined();
			expect(toolRow).toMatch(/\d+s$/);
			for (const line of out.split("\n")) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns);
			}
		});

		it("fits every rendered component row within the viewport without wrapping the elapsed marker", () => {
			const sessions = [
				makeSession({
					id: "Builder",
					description: "Narrow build",
					progress: makeProgress({
						id: "Builder",
						currentTool: "bash",
						currentToolArgs: `cat ${os.homedir()}/.ssh/config`,
						currentToolStartMs: Date.now() - 10_000,
					}),
				}),
				makeSession({
					id: "Reader",
					progress: makeProgress({
						id: "Reader",
						currentTool: "read",
						currentToolArgs: "x".repeat(300),
						currentToolStartMs: Date.now() - 12_000,
					}),
				}),
			];
			for (const columns of [60, 120]) {
				const hud = new SubagentHudComponent(
					renderSubagentHudLines(sessions, columns, false, true),
					sessions.map(session => session.id),
				);
				const rows = hud.render(columns).map(row => Bun.stripANSI(row));
				for (const row of rows) {
					expect(Bun.stringWidth(row)).toBeLessThanOrEqual(columns);
				}
				const elapsedRows = rows.filter(row => /\d+s/.test(row));
				expect(elapsedRows.length).toBeGreaterThan(0);
				for (const row of elapsedRows) {
					expect(row).toMatch(/bash|read/);
				}
			}
		});

		it("routes clicks on a preview row to its agent and keeps later rows and the expander aligned", () => {
			const sessions = ["Alpha", "Beta", "Gamma", "Delta", "E5", "F6", "G7", "H8", "I9", "J10"].map(id =>
				makeSession({ id, progress: makeProgress({ id, currentTool: "read", currentToolArgs: `${id}.ts` }) }),
			);
			const layout = layoutPinnedHud(sessions.length, false);
			const hud = new SubagentHudComponent(
				renderSubagentHudLines(sessions, 120, false, true),
				sessions.map(session => session.id),
				layout.toggleRow,
			);
			const rows = hud.render(120).map(row => Bun.stripANSI(row));
			const rowOf = (text: string) => rows.findIndex(row => row.includes(text));
			expect(hud.getClickAgentAtRow(rowOf("Alpha.ts"))).toBe("Alpha");
			expect(hud.getClickAgentAtRow(rowOf("Beta"))).toBe("Beta");
			expect(hud.getClickAgentAtRow(rowOf("Gamma.ts"))).toBe("Gamma");
			expect(hud.getClickAgentAtRow(rowOf("more — expand"))).toBe(PINNED_HUD_TOGGLE_ID);
		});

		it("labels a call with its own intent, never an earlier call's", () => {
			const out = render(
				[
					makeSession({
						id: "Worker",
						progress: makeProgress({
							id: "Worker",
							lastIntent: "Reading auth config",
							currentTool: "mcp__db_query",
							currentToolArgs: "SELECT 1",
							recentTools: [{ tool: "read", args: "auth.ts", intent: "Reading auth config", endMs: 1 }],
						}),
					}),
					makeSession({
						id: "Between",
						progress: makeProgress({
							id: "Between",
							lastIntent: "Reading auth config",
							recentTools: [{ tool: "mcp__db_query", args: "SELECT 2", endMs: 2 }],
						}),
					}),
					makeSession({
						id: "Intentful",
						progress: makeProgress({
							id: "Intentful",
							currentTool: "read",
							currentToolArgs: "auth.ts",
							currentToolIntent: "Checking the session cookie",
						}),
					}),
				],
				120,
				true,
			);
			expect(out).toContain("mcp__db_query: SELECT 1");
			expect(out).toContain("mcp__db_query: SELECT 2");
			expect(out).toContain("read: Checking the session cookie");
			expect(out).not.toContain("Reading auth config");
		});

		it("keeps the header and agent rows within the padded HUD width", () => {
			const sessions = [
				makeSession({ id: `Worker${"W".repeat(80)}`, description: "Every available column ".repeat(10) }),
			];
			for (const columns of [40, 60]) {
				const hud = new SubagentHudComponent(renderSubagentHudLines(sessions, columns, false, true), [
					sessions[0]!.id,
				]);
				// No wrapping: exactly the blank row, the header and one agent row.
				expect(hud.render(columns)).toHaveLength(3);
			}
		});

		it("arms the repaint for when the elapsed marker first shows, then every second", () => {
			const now = 100_000;
			const midCall = (id: string, startMs: number) =>
				makeSession({ id, progress: makeProgress({ id, currentTool: "bash", currentToolStartMs: startMs }) });
			const thinking = makeSession({ id: "Thinking", progress: makeProgress({ id: "Thinking" }) });
			expect(nextSubagentPreviewTickMs([thinking], now)).toBeUndefined();
			expect(nextSubagentPreviewTickMs([midCall("Fresh", now - 1_000)], now)).toBe(4_001);
			expect(nextSubagentPreviewTickMs([midCall("Long", now - 30_000)], now)).toBe(1_000);
			expect(
				nextSubagentPreviewTickMs([thinking, midCall("Fresh", now - 4_500), midCall("Long", now - 30_000)], now),
			).toBe(501);
		});
	});
});

describe("SubagentHudComponent click rows", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("maps item rows to session ids and chrome rows nowhere", () => {
		const lines = renderSubagentHudLines([makeSession({ id: "Alpha" }), makeSession({ id: "Beta" })], 120);
		const hud = new SubagentHudComponent(lines, ["Alpha", "Beta"]);

		const rendered = hud.render(120);
		expect(rendered).toHaveLength(lines.length);
		expect(Bun.stripANSI(rendered[2] ?? "")).toContain("Alpha");
		expect(Bun.stripANSI(rendered[3] ?? "")).toContain("Beta");

		expect(hud.getClickAgentAtRow(0)).toBeUndefined();
		expect(hud.getClickAgentAtRow(1)).toBeUndefined();
		expect(hud.getClickAgentAtRow(2)).toBe("Alpha");
		expect(hud.getClickAgentAtRow(3)).toBe("Beta");
		expect(hud.getClickAgentAtRow(4)).toBeUndefined();
		expect(hud.getClickAgentAtRow(-1)).toBeUndefined();
	});

	it("resolves the expander row to the toggle sentinel", () => {
		const hud = new SubagentHudComponent(["", "Subagents", "row", "toggle"], ["Only"], 3);
		hud.render(120);
		expect(hud.getClickAgentAtRow(3)).toBe(PINNED_HUD_TOGGLE_ID);
		expect(hud.getClickAgentAtRow(2)).toBe("Only");
	});

	it("maps wrapped continuation rows to the agent that started them", () => {
		const long = ` ${"x".repeat(200)}`;
		const hud = new SubagentHudComponent(["", "Subagents", long, "short"], ["Long", "Short"]);
		const rendered = hud.render(40);
		expect(rendered.length).toBeGreaterThan(4);
		const shortRow = rendered.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(shortRow).toBeGreaterThan(3);
		expect(hud.getClickAgentAtRow(2)).toBe("Long");
		expect(hud.getClickAgentAtRow(3)).toBe("Long");
		expect(hud.getClickAgentAtRow(shortRow)).toBe("Short");
		expect(hud.getClickAgentAtRow(shortRow + 1)).toBeUndefined();
	});

	it("maps clicks after wrapping and resizing while leaving clicks before rendering unmapped", () => {
		const hud = new SubagentHudComponent(["", "Subagents", ` ${"x".repeat(100)}`, "short"], ["Long", "Short"]);
		expect(hud.getClickAgentAtRow(2)).toBeUndefined();

		const narrowRows = hud.render(40);
		const narrowShortRow = narrowRows.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(narrowShortRow).toBeGreaterThan(3);
		expect(hud.getClickAgentAtRow(narrowShortRow - 1)).toBe("Long");
		expect(hud.getClickAgentAtRow(narrowShortRow)).toBe("Short");

		const wideRows = hud.render(120);
		expect(wideRows.length).toBeLessThan(narrowRows.length);
		const wideShortRow = wideRows.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(hud.getClickAgentAtRow(wideShortRow)).toBe("Short");
		expect(hud.getClickAgentAtRow(wideShortRow + 1)).toBeUndefined();
	});

	it("remaps clicks when runtime character width changes", () => {
		setHangulCompatibilityJamoWidth(1);
		try {
			const hud = new SubagentHudComponent(["", "Subagents", ` ${"ㅁ".repeat(25)}`, "next"], ["Jamo", "Next"]);
			const narrowRows = hud.render(40);
			const narrowNextRow = narrowRows.findIndex(line => Bun.stripANSI(line).includes("next"));
			expect(hud.getClickAgentAtRow(narrowNextRow)).toBe("Next");

			setHangulCompatibilityJamoWidth(2);
			expect(hud.getClickAgentAtRow(narrowNextRow)).toBe("Next");
			const wideRows = hud.render(40);
			const wideNextRow = wideRows.findIndex(line => Bun.stripANSI(line).includes("next"));
			expect(wideNextRow).toBeGreaterThan(narrowNextRow);
			expect(hud.getClickAgentAtRow(wideNextRow - 1)).toBe("Jamo");
			expect(hud.getClickAgentAtRow(wideNextRow)).toBe("Next");
		} finally {
			resetHangulCompatibilityJamoWidthForTests();
		}
	});
});

describe("InteractiveMode subagent observer UI sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-subagent-observer-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		setSystemTime();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("keeps activity rows attached to their agent in the mounted HUD", async () => {
		cfgDisplaySubagentLivePreview.override(session.settings, true);
		await mode.init({ suppressWelcomeIntro: true });
		for (const [index, id] of ["Alpha", "Beta"].entries()) {
			const payload = makeProgressPayload(id, index, `Inspect ${id}`, true);
			eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
				...payload,
				progress: { ...payload.progress, currentTool: "read", currentToolArgs: `${id}.ts`, currentToolStartMs: 1 },
			});
			await Promise.resolve();
		}
		const hud = mode.subagentContainer.children.find(child => child instanceof SubagentHudComponent);
		if (!(hud instanceof SubagentHudComponent)) throw new Error("Expected mounted subagent HUD");
		const rows = hud.render(120).map(row => Bun.stripANSI(row));
		for (const id of ["Alpha", "Beta"]) {
			const titleRow = rows.findIndex(row => row.includes(id) && !row.includes(`${id}.ts`));
			const activityRow = rows.findIndex(row => row.includes(`read: ${id}.ts`));
			expect(titleRow).toBeGreaterThanOrEqual(0);
			expect(activityRow).toBeGreaterThan(titleRow);
			expect(hud.getClickAgentAtRow(titleRow)).toBe(id);
			expect(hud.getClickAgentAtRow(activityRow)).toBe(id);
		}
	});

	it("renders tool lifecycle changes without waiting for the progress debounce", async () => {
		cfgDisplaySubagentLivePreview.override(session.settings, true);
		await mode.init({ suppressWelcomeIntro: true });
		vi.useFakeTimers();
		const payload = makeProgressPayload("FastReader", 0, "Inspecting source", true);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...payload,
			progress: { ...payload.progress, currentTool: "read", currentToolArgs: "package.json", currentToolStartMs: 1 },
		});
		await Promise.resolve();
		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).toContain("read: package.json");
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...payload,
			progress: { ...payload.progress, currentTool: "read", currentToolArgs: "bun.lock", currentToolStartMs: 1 },
		});
		await Promise.resolve();
		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).toContain("read: bun.lock");
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...payload,
			progress: { ...payload.progress, recentTools: [{ tool: "read", args: "bun.lock", endMs: 2 }] },
		});
		await Promise.resolve();
		const settled = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(settled).toContain("FastReader");
		expectSameRow(settled, theme.symbol("status.success"), "read: bun.lock");
	});

	it("coalesces a burst of progress observer changes into one HUD rebuild and render request", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const mountHud = vi.spyOn(mode.subagentContainer, "addChild");
		const updateHud = vi.spyOn(SubagentHudComponent.prototype, "update");
		vi.useFakeTimers();

		for (let index = 0; index < 6; index++) {
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				makeProgressPayload(`BurstAgent${index}`, index, `Burst job ${index}`, true),
			);
		}

		await Promise.resolve();
		vi.runAllTimers();
		await Promise.resolve();

		const hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		// This branch shows up to eight agents before collapsing, so all six burst agents are visible.
		expectSameRow(hud, "BurstAgent0", "Burst job 0");
		expectSameRow(hud, "BurstAgent5", "Burst job 5");
		expect(hud).not.toContain("more — expand");
		expect(mountHud.mock.calls.length + updateHud.mock.calls.length).toBe(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
	it("rebuilds HUD immediately when badge setting changes", async () => {
		cfgDisplaySubagentLivePreview.override(session.settings, true);
		await mode.init({ suppressWelcomeIntro: true });
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			...makeProgressPayload("LongRunner", 0, "Long-running work", true),
			progress: makeProgress({
				id: "LongRunner",
				description: "Long-running work",
				task: "Long-running work",
				resolvedModel: "openai/gpt-5.6-sol",
			}),
		});
		vi.useFakeTimers();
		await Promise.resolve();
		vi.runAllTimers();
		await Promise.resolve();
		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).not.toContain("openai/gpt-5.6-sol");
		cfgTaskShowResolvedModelBadge.override(session.settings, true);
		// Setting listeners coalesce per microtask; the rebuild lands before the next frame.
		await Promise.resolve();
		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).toContain("openai/gpt-5.6-sol");
	});

	it("advances a quiet call's elapsed marker by repainting the same HUD in place", async () => {
		cfgDisplaySubagentLivePreview.override(session.settings, true);
		await mode.init({ suppressWelcomeIntro: true });
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		setSystemTime(1_000_000);
		const payload = makeProgressPayload("Sleeper", 0, "Run sleep", true);
		payload.progress = {
			...payload.progress,
			currentTool: "bash",
			currentToolArgs: "sleep 40",
			currentToolStartMs: 1_000_000 - 20_000,
		};
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, payload);
		await Promise.resolve();
		vi.advanceTimersByTime(100); // observer UI coalesce window
		const hudText = () => Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		const hud = mode.subagentContainer.children[0];
		expect(hudText()).toMatch(/bash: sleep 40 · 20\.[01]s/);

		vi.advanceTimersByTime(1_000);
		expect(mode.subagentContainer.children[0]).toBe(hud);
		expect(hudText()).toMatch(/bash: sleep 40 · 21\.[01]s/);
	});
});
