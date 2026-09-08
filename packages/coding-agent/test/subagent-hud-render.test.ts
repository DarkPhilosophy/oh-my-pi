/**
 * Contract: the anchored subagent HUD (rendered above the editor, next to the
 * Todos block) lists exactly the running *detached* subagents as paired ID and
 * activity rows and yields no output once nothing qualifies, so the block
 * self-clears. Sync task spawns and eval `agent()` spawns are excluded:
 * their progress is already rendered inline (tool block / eval cell).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode, renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import {
	type ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

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

function render(sessions: ObservableSession[], columns = 120, showResolvedModelBadge = false): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, columns, showResolvedModelBadge).join("\n"));
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

	it("renders running subagent ids and descriptions together under a Subagents header", () => {
		const out = render([
			makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" }),
			makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
		]);
		expect(out).toContain("Subagents");
		expectSameRow(out, "AuthLoader", "Refactoring the auth flow");
		expectSameRow(out, "SchemaMigrator", "Migrating the users table");
	});

	it("shows the resolved model only when configured", () => {
		const sessions = [
			makeSession({
				id: "AuthLoader",
				description: "Refactoring the auth flow",
				progress: makeProgress({ id: "AuthLoader", resolvedModel: "openai/gpt-5.6-sol" }),
			}),
		];
		const withoutModel = render(sessions, 120, false);
		const withModel = render(sessions, 120, true);
		expect(withoutModel).not.toContain("openai/gpt-5.6-sol");
		expectSameRow(withModel, "AuthLoader", "openai/gpt-5.6-sol", "Refactoring the auth flow");
	});

	it("shows only the current tool on a bounded second row", () => {
		const active = makeSession({
			id: "Reader",
			description: "Inspecting renderer behavior",
			progress: makeProgress({
				id: "Reader",
				lastIntent: "Inspecting renderer behavior",
				currentTool: "read",
				currentToolArgs: "packages/coding-agent/src/modes/interactive-mode.ts",
			}),
		});
		const activeLines = renderSubagentHudLines([active], 40);
		expect(activeLines).toHaveLength(4);
		expect(Bun.stripANSI(activeLines[3]!)).toContain("read(packages/");
		expect(Bun.stripANSI(activeLines.join("\n"))).not.toContain("old search");
		for (const line of activeLines) expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(40);

		const settled = makeSession({
			...active,
			progress: makeProgress({
				id: "Reader",

				lastIntent: "Inspecting renderer behavior",
				recentTools: [
					{ tool: "read", args: "packages/coding-agent/src/modes/interactive-mode.ts", endMs: Date.now() },
				],
			}),
		});
		const settledLines = renderSubagentHudLines([settled], 40);
		expect(settledLines).toHaveLength(3);
		expect(Bun.stripANSI(settledLines.join("\n"))).not.toContain("read(");
	});

	it("formats selected tool arguments by semantic key without changing raw command text", () => {
		const homePath = path.join(process.env.HOME!, "private-project", "secret.ts");
		const pathOut = render([
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
		expect(pathOut).toContain("ast_grep(~/private-project/secret.ts)");
		expect(pathOut).not.toContain(process.env.HOME!);

		const patternOut = render([
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
		expect(patternOut).toContain(`grep(${homePath})`);

		const command = `${homePath} --check`;
		const rawInvocation = { command };
		const bashOut = render([
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
		expect(bashOut).toContain("bash(~/private-project/secret.ts --check)");
		expect(rawInvocation).toEqual({ command });
	});

	it("prefers generated progress labels over wrapped task text", () => {
		const out = render([
			makeSession({
				id: "Worker",
				progress: makeProgress({
					id: "Worker",
					description: "Generated progress label",
					assignment: "Inspect HUD precedence",
					task: "Complete assignment thoroughly:\n\n# Target\nHUD",
				}),
			}),
		]);
		expectSameRow(out, "Worker", "Generated progress label");
		expect(out).not.toContain("Complete assignment thoroughly");
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
		// Sync task spawn (parent blocked on the call) and eval `agent()` spawn
		// (no detached flag at all) both stay off the HUD.
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
		expect(out).toContain("2 more running");
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
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("coalesces a burst of progress observer changes into one HUD rebuild and render request", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const rebuildHud = vi.spyOn(mode.subagentContainer, "clear");
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
		expectSameRow(hud, "BurstAgent0", "Burst job 0");
		expectSameRow(hud, "BurstAgent5", "Burst job 5");
		expect(rebuildHud).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("rebuilds a running-agent HUD immediately when the resolved-model badge setting changes", async () => {
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

		session.settings.override("task.showResolvedModelBadge", true);

		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).toContain("openai/gpt-5.6-sol");
	});
});
