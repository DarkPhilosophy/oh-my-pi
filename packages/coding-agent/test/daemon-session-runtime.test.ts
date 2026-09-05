import { afterEach, describe, expect, type Mock, test, vi } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { Settings } from "../src/config/settings";
import { createAgentSessionRuntime } from "../src/daemon/session-runtime";
import type { HostedTerminalDescriptor } from "../src/daemon/terminal-bridge";
import * as interactiveModeModule from "../src/modes/interactive-mode";
import * as themeModule from "../src/modes/theme/theme";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { CreateAgentSessionResult } from "../src/sdk";
import {
	type AgentSession,
	type AgentSessionDisposeOptions,
	SHUTDOWN_CONSOLIDATE_BUDGET_MS,
} from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("daemon session runtime", () => {
	test("bounds memory consolidation while disposing a hosted session", async () => {
		let disposeOptions: AgentSessionDisposeOptions | undefined;
		const runtime = await createAgentSessionRuntime({
			cwd: process.cwd(),
			sessionId: "hosted",
			createSession: async options => {
				const session = {
					sessionId: "hosted",
					isStreaming: false,
					subscribe: () => () => {},
					subscribeCommandMetadataChanged: () => () => {},
					dispose: async (received?: AgentSessionDisposeOptions) => {
						disposeOptions = received;
						await options.sessionManager?.close();
					},
				} as unknown as AgentSession;
				return {
					session,
					setToolUIContext: () => {},
				} as unknown as CreateAgentSessionResult;
			},
		});

		await runtime.dispose();

		expect(disposeOptions?.mnemopiConsolidateTimeoutMs).toBe(SHUTDOWN_CONSOLIDATE_BUDGET_MS);
	});
	test("seeds a recovered CLI runtime with the requested session identity", async () => {
		let createdSessionId: string | undefined;
		const runtime = await createAgentSessionRuntime({
			cwd: process.cwd(),
			sessionId: "stable-recovery-id",
			overrides: { argv: ["--no-session", "--no-extensions"] },
			createSession: async options => {
				createdSessionId = options.sessionManager?.getSessionId();
				const session = {
					sessionId: createdSessionId,
					isStreaming: false,
					subscribe: () => () => {},
					subscribeCommandMetadataChanged: () => () => {},
					dispose: async () => {
						await options.sessionManager?.close();
					},
				} as unknown as AgentSession;
				return {
					session,
					setToolUIContext: () => {},
				} as unknown as CreateAgentSessionResult;
			},
		});
		try {
			expect(createdSessionId).toBe("stable-recovery-id");
			expect(runtime.sessionId).toBe("stable-recovery-id");
			expect(runtime.session.sessionId).toBe("stable-recovery-id");
		} finally {
			await runtime.dispose();
		}
	});
	test("requests hosted terminal exit with an exit reason", async () => {
		let shuttingDown = false;
		const input = Promise.withResolvers<{ text: string; cancelled: boolean; started: boolean }>();
		const detachHosted = vi.fn(() => {
			shuttingDown = true;
			input.resolve({ text: "", cancelled: true, started: false });
		});
		vi.spyOn(themeModule, "initTheme").mockResolvedValue(undefined);
		vi.spyOn(
			interactiveModeModule as unknown as { InteractiveMode: () => interactiveModeModule.InteractiveMode },
			"InteractiveMode",
		).mockImplementation(
			() =>
				({
					get isShuttingDown() {
						return shuttingDown;
					},
					detachHosted,
					init: async () => {},
					renderInitialMessages: () => {},
					setDaemonSnapshot: () => {},
					getUserInput: () => input.promise,
				}) as unknown as interactiveModeModule.InteractiveMode,
		);
		const runtime = await createAgentSessionRuntime({
			cwd: process.cwd(),
			sessionId: "hosted-exit",
			createSession: async options => {
				const session = {
					sessionId: "hosted-exit",
					isStreaming: false,
					subscribe: () => () => {},
					subscribeCommandMetadataChanged: () => () => {},
					settings: { get: () => undefined },
					sessionManager: { getCwd: () => process.cwd() },
					dispose: async () => {
						await options.sessionManager?.close();
					},
				} as unknown as AgentSession;
				return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
			},
		});
		try {
			const start = runtime.command(
				{ type: "terminal_start", terminal: { columns: 80, rows: 24 } },
				"exit-attachment",
			);
			await Bun.sleep(0);
			expect(typeof runtime.requestClientExit).toBe("function");
			runtime.requestClientExit?.();
			await start;
			expect(detachHosted).toHaveBeenCalledWith("exit");
		} finally {
			await runtime.dispose();
		}
	});

	test("keeps creation and commands inside each session working-directory context", async () => {
		const root = process.cwd();
		const firstCwd = path.join(root, "first-project");
		const secondCwd = path.join(root, "second-project");
		const creationCwds: string[] = [];
		const createRuntime = (cwd: string, sessionId: string) =>
			createAgentSessionRuntime({
				cwd,
				sessionId,
				createSession: async options => {
					creationCwds.push(getProjectDir());
					const session = {
						sessionId,
						isStreaming: false,
						subscribe: () => () => {},
						subscribeCommandMetadataChanged: () => () => {},
						getSessionStats: () => ({ cwd: getProjectDir() }),
						dispose: async () => {
							await options.sessionManager?.close();
						},
					} as unknown as AgentSession;
					return {
						session,
						setToolUIContext: () => {},
					} as unknown as CreateAgentSessionResult;
				},
			});

		const [first, second] = await Promise.all([createRuntime(firstCwd, "first"), createRuntime(secondCwd, "second")]);
		try {
			expect(creationCwds).toEqual([firstCwd, secondCwd]);
			expect(await first.command({ type: "get_session_stats" })).toEqual({ cwd: firstCwd });
			expect(await second.command({ type: "get_session_stats" })).toEqual({ cwd: secondCwd });
			expect(getProjectDir()).toBe(root);
		} finally {
			await Promise.all([first.dispose(), second.dispose()]);
		}
	});

	test("keeps runtime cwd metadata live after session relocation", async () => {
		const originalCwd = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-cwd-before-"));
		const movedCwd = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-cwd-after-"));
		let sessionManager: SessionManager | undefined;
		const runtime = await createAgentSessionRuntime({
			cwd: originalCwd,
			sessionId: "relocated-session",
			createSession: async options => {
				sessionManager = options.sessionManager;
				const session = {
					sessionId: "relocated-session",
					isStreaming: false,
					subscribe: () => () => {},
					subscribeCommandMetadataChanged: () => () => {},
					dispose: async () => {
						await options.sessionManager?.close();
					},
				} as unknown as AgentSession;
				return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
			},
		});
		try {
			if (!sessionManager) throw new Error("runtime must inject a session manager");
			await sessionManager.moveTo(movedCwd);

			expect(runtime.cwd).toBe(movedCwd);
			expect((await runtime.snapshot()).cwd).toBe(movedCwd);
			const state = (await runtime.command({ type: "get_state" })) as { cwd?: string };
			expect(state.cwd).toBe(movedCwd);
		} finally {
			await runtime.dispose();
			await Promise.all([
				rm(originalCwd, { recursive: true, force: true }),
				rm(movedCwd, { recursive: true, force: true }),
			]);
		}
	});
	test("isolates concurrent runtime registries and re-enters each command scope", async () => {
		const registries: AgentRegistry[] = [];
		const createRuntime = (sessionId: string) =>
			createAgentSessionRuntime({
				cwd: process.cwd(),
				sessionId,
				createSession: async options => {
					const registry = options.agentRegistry;
					expect(registry).toBeDefined();
					if (!registry) throw new Error("runtime must inject an agent registry");
					registries.push(registry);
					registry.register({
						id: `child-${sessionId}`,
						displayName: `Child ${sessionId}`,
						kind: "sub",
						parentId: sessionId,
						session: null,
					});
					expect(AgentRegistry.global()).toBe(registry);
					const session = {
						sessionId,
						isStreaming: false,
						subscribe: () => () => {},
						subscribeCommandMetadataChanged: () => () => {},
						getSessionStats: () => ({
							registryIds: AgentRegistry.global()
								.list()
								.map(ref => ref.id),
						}),
						dispose: async () => {
							await options.sessionManager?.close();
						},
					} as unknown as AgentSession;
					return {
						session,
						setToolUIContext: () => {},
					} as unknown as CreateAgentSessionResult;
				},
			});

		const [first, second] = await Promise.all([createRuntime("first-registry"), createRuntime("second-registry")]);
		try {
			expect(registries).toHaveLength(2);
			expect(registries[0]).not.toBe(registries[1]);
			expect(registries[0]!.list().map(ref => ref.id)).toEqual(["child-first-registry"]);
			expect(registries[1]!.list().map(ref => ref.id)).toEqual(["child-second-registry"]);
			expect(await first.command({ type: "get_session_stats" })).toEqual({
				registryIds: ["child-first-registry"],
			});
			expect(await second.command({ type: "get_session_stats" })).toEqual({
				registryIds: ["child-second-registry"],
			});
		} finally {
			await Promise.all([first.dispose(), second.dispose()]);
		}
	});

	test("reports the underlying session id in RPC state, not the registry handle", async () => {
		// The registry id is a random per-daemon UUID; the resume hint (and any
		// other state consumer) needs the persisted session's own id — resuming
		// by registry id can never find a session file.
		const runtime = await createAgentSessionRuntime({
			cwd: process.cwd(),
			sessionId: "registry-handle-id",
			createSession: async options => {
				const session = {
					sessionId: "0197-real-session-id",
					sessionFile: "/tmp/0197-real-session-id.jsonl",
					isStreaming: false,
					subscribe: () => () => {},
					subscribeCommandMetadataChanged: () => () => {},
					dispose: async () => {
						await options.sessionManager?.close();
					},
				} as unknown as AgentSession;
				return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
			},
		});
		try {
			const state = (await runtime.command({ type: "get_state" })) as { sessionId?: string; sessionFile?: string };
			expect(state.sessionId).toBe("0197-real-session-id");
			expect(state.sessionFile).toBe("/tmp/0197-real-session-id.jsonl");
			// The registry keeps addressing the runtime by its own handle.
			expect(runtime.sessionId).toBe("registry-handle-id");
		} finally {
			await runtime.dispose();
		}
	});

	test("resume argv opens the persisted session instead of silently creating a fresh one", async () => {
		// User-reported critical regression shape: `omp --daemon --resume <id>`
		// appeared to work while hosting an EMPTY new session. The daemon-side
		// CLI launch must resolve the resume id to the existing transcript and
		// hand that exact SessionManager to session creation.
		const launchCwd = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-launch-"));
		const resumedCwd = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-resume-"));
		const fixture = SessionManager.create(resumedCwd);
		const persistedId = fixture.getSessionId();
		fixture.appendMessage({ role: "user", content: "resume fixture", timestamp: Date.now() });
		fixture.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "fixture ack" }],
			timestamp: Date.now(),
			stopReason: "stop",
			api: "openai-completions",
			model: "mock",
			provider: "mock",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		const persistedFile = fixture.getSessionFile();
		await fixture.close();

		let resumedId: string | undefined;
		let resumedFile: string | undefined;
		let resumedManagerCwd: string | undefined;
		let effectiveProjectDir: string | undefined;
		let createOptionsCwd: string | undefined;
		try {
			const runtime = await createAgentSessionRuntime({
				cwd: launchCwd,
				sessionId: "registry-resume-handle",
				overrides: { argv: ["--resume", persistedId, "--no-extensions"] },
				createSession: async options => {
					resumedId = options.sessionManager?.getSessionId();
					resumedFile = options.sessionManager?.getSessionFile() ?? undefined;
					resumedManagerCwd = options.sessionManager?.getCwd();
					createOptionsCwd = options.cwd;
					effectiveProjectDir = getProjectDir();
					const session = {
						sessionId: resumedId,
						isStreaming: false,
						subscribe: () => () => {},
						subscribeCommandMetadataChanged: () => () => {},
						dispose: async () => {
							await options.sessionManager?.close();
						},
					} as unknown as AgentSession;
					return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
				},
			});
			await runtime.dispose();
			expect(resumedId).toBe(persistedId);
			expect(resumedFile).toBe(persistedFile ?? undefined);
			expect(resumedManagerCwd).toBe(resumedCwd);
			expect(createOptionsCwd).toBe(resumedCwd);
			expect(effectiveProjectDir).toBe(resumedCwd);
		} finally {
			await rm(launchCwd, { recursive: true, force: true });
			await rm(resumedCwd, { recursive: true, force: true });
			if (persistedFile) await rm(path.dirname(persistedFile), { recursive: true, force: true });
		}
	}, 30_000);

	test("direct sessionFile adopts transcript cwd for scope, settings, state, snapshot, and switch", async () => {
		const launchCwd = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-direct-launch-"));
		const resumedCwd = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-direct-resume-"));
		const movedCwd = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-direct-move-"));
		const switchedCwd = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-direct-switch-"));
		const sessionDir = await mkdtemp(path.join(os.tmpdir(), "omp-daemon-direct-sessions-"));
		const fixture = SessionManager.create(resumedCwd, sessionDir);
		fixture.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "direct resume fixture" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "fixture",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const sessionFile = fixture.getSessionFile();
		await fixture.close();
		const switchedFixture = SessionManager.create(switchedCwd, sessionDir);
		switchedFixture.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "switch fixture" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "fixture",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const switchedFile = switchedFixture.getSessionFile();
		await switchedFixture.close();
		if (!sessionFile || !switchedFile) throw new Error("Expected persisted session fixtures");

		const settings = await Settings.loadIsolated({ cwd: launchCwd, inMemory: true });
		let sessionManager: SessionManager | undefined;
		let creationCwd: string | undefined;
		let creationProjectDir: string | undefined;
		let creationSettingsCwd: string | undefined;
		let refreshProjectDir: string | undefined;
		let refreshSettingsCwd: string | undefined;
		try {
			const runtime = await createAgentSessionRuntime({
				cwd: launchCwd,
				sessionId: "registry-direct-resume-handle",
				sessionFile,
				sessionDir,
				baseOptions: { settings },
				createSession: async options => {
					sessionManager = options.sessionManager;
					creationCwd = options.cwd;
					creationProjectDir = getProjectDir();
					creationSettingsCwd = options.settings?.getCwd();
					const session = {
						sessionId: options.sessionManager?.getSessionId(),
						settings: options.settings,
						sessionManager: options.sessionManager,
						customCommands: [],
						skills: [],
						isStreaming: false,
						subscribe: () => () => {},
						subscribeCommandMetadataChanged: () => () => {},
						setSlashCommands: () => {},
						refreshSkills: async () => {
							refreshProjectDir = getProjectDir();
							refreshSettingsCwd = options.settings?.getCwd();
						},
						switchSession: async (target: string) => {
							await options.sessionManager?.setSessionFile(target);
							return true;
						},
						dispose: async () => {
							await options.sessionManager?.close();
						},
					} as unknown as AgentSession;
					return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
				},
			});
			expect(sessionManager?.getCwd()).toBe(resumedCwd);
			expect(creationCwd).toBe(resumedCwd);
			expect(creationProjectDir).toBe(resumedCwd);
			expect(creationSettingsCwd).toBe(resumedCwd);

			await sessionManager?.moveTo(movedCwd, sessionDir);
			expect(await runtime.command({ type: "get_state" })).toMatchObject({ cwd: movedCwd });
			expect(runtime.snapshot()).toMatchObject({
				cwd: movedCwd,
				state: { cwd: movedCwd },
				header: { cwd: movedCwd },
			});
			expect(runtime.cwd).toBe(movedCwd);

			expect(await runtime.command({ type: "switch_session", sessionPath: switchedFile })).toEqual({
				cancelled: false,
			});
			expect(sessionManager?.getCwd()).toBe(switchedCwd);
			expect(settings.getCwd()).toBe(switchedCwd);
			expect(refreshProjectDir).toBe(switchedCwd);
			expect(refreshSettingsCwd).toBe(switchedCwd);
			expect(await runtime.command({ type: "get_state" })).toMatchObject({ cwd: switchedCwd });
			expect(runtime.snapshot()).toMatchObject({
				cwd: switchedCwd,
				state: { cwd: switchedCwd },
				header: { cwd: switchedCwd },
			});
			expect(runtime.cwd).toBe(switchedCwd);
			await runtime.dispose();
		} finally {
			await sessionManager?.close().catch(() => undefined);
			await rm(launchCwd, { recursive: true, force: true });
			await rm(resumedCwd, { recursive: true, force: true });
			await rm(movedCwd, { recursive: true, force: true });
			await rm(switchedCwd, { recursive: true, force: true });
			await rm(sessionDir, { recursive: true, force: true });
		}
	}, 30_000);

	test("hosted terminal emits terminal_cwd on start and on interactive cwd changes", async () => {
		const renderReplay = Promise.withResolvers<void>();
		type FakeMode = {
			isShuttingDown: boolean;
			detachHosted: Mock<() => void>;
			init: () => Promise<void>;
			renderInitialMessages: () => void;
			setDaemonSnapshot: () => void;
			getUserInput: () => Promise<unknown>;
		};
		const makeFakeMode = (): FakeMode => {
			const input = Promise.withResolvers<unknown>();
			const mode: FakeMode = {
				isShuttingDown: false,
				detachHosted: vi.fn(() => {
					mode.isShuttingDown = true;
					input.resolve({ text: "", cancelled: true, started: false });
				}),
				init: async () => {},
				renderInitialMessages: () => renderReplay.promise,
				setDaemonSnapshot: () => {},
				getUserInput: () => input.promise,
			};
			return mode;
		};
		vi.spyOn(themeModule, "initTheme").mockResolvedValue(undefined);
		type ModeFactory = { InteractiveMode: () => interactiveModeModule.InteractiveMode };
		let hostedCwdChange: ((cwd: string) => void) | undefined;
		const modeCtor = vi
			.spyOn(interactiveModeModule as unknown as ModeFactory, "InteractiveMode")
			.mockImplementation(function (this: unknown, ...args: unknown[]) {
				hostedCwdChange = (args[7] as { onCwdChange?: (cwd: string) => void } | undefined)?.onCwdChange;
				return makeFakeMode() as unknown as interactiveModeModule.InteractiveMode;
			});
		const runtime = await createAgentSessionRuntime({
			cwd: process.cwd(),
			sessionId: "hosted-cwd",
			createSession: async options => {
				const session = {
					sessionId: "hosted-cwd",
					isStreaming: false,
					subscribe: () => () => {},
					subscribeCommandMetadataChanged: () => () => {},
					settings: { get: () => undefined },
					sessionManager: { getCwd: () => process.cwd() },
					dispose: async () => {
						await options.sessionManager?.close();
					},
				} as unknown as AgentSession;
				return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
			},
		});
		const bridgeEvents: unknown[] = [];
		const unsubscribeBridgeEvents = runtime.subscribe(event => bridgeEvents.push(event));
		const descriptor = {
			columns: 80,
			rows: 24,
			kittyProtocolActive: false,
			kittyEnableSequence: null,
			clientEnv: { TERM: "xterm-256color" },
		} as HostedTerminalDescriptor;
		const previousChalkLevel = chalk.level;
		try {
			// A daemon imports chalk with a pipe stdout (level 0). terminal_start
			// must re-enable styles for the attached client terminal.
			chalk.level = 0;
			const start = runtime.command({ type: "terminal_start", terminal: descriptor }, "a1");
			await Promise.resolve();
			expect(modeCtor).toHaveBeenCalledTimes(1);
			expect(bridgeEvents).toContainEqual({ type: "terminal_cwd", cwd: process.cwd() });
			let startSettled = false;
			void start.then(() => {
				startSettled = true;
			});
			await Promise.resolve();
			expect(startSettled).toBe(false);
			renderReplay.resolve();
			await start;
			expect(chalk.italic("thinking")).toBe("\x1b[3mthinking\x1b[23m");
			hostedCwdChange?.("/tmp/resumed-project");
			expect(bridgeEvents).toContainEqual({ type: "terminal_cwd", cwd: "/tmp/resumed-project" });
		} finally {
			chalk.level = previousChalkLevel;
			unsubscribeBridgeEvents();
			await runtime.dispose();
		}
	});

	test("terminal_start takes over a defunct hosted terminal without awaiting its pinned task", async () => {
		type FakeMode = {
			isShuttingDown: boolean;
			detachHosted: Mock<() => void>;
			init: () => Promise<void>;
			renderInitialMessages: () => void;
			setDaemonSnapshot: () => void;
			getUserInput: () => Promise<unknown>;
		};
		const modes: FakeMode[] = [];
		const makeFakeMode = (): FakeMode => {
			const input = Promise.withResolvers<unknown>();
			const mode: FakeMode = {
				isShuttingDown: false,
				detachHosted: vi.fn(() => {
					mode.isShuttingDown = true;
					// The first host simulates a mode pinned by an in-flight turn:
					// its loop never settles even after detach. Later hosts settle
					// cooperatively so dispose() can drain the active task.
					if (modes[0] !== mode) input.resolve({ text: "", cancelled: true, started: false });
				}),
				init: async () => {},
				renderInitialMessages: () => {},
				setDaemonSnapshot: () => {},
				getUserInput: () => input.promise,
			};
			modes.push(mode);
			return mode;
		};
		vi.spyOn(themeModule, "initTheme").mockResolvedValue(undefined);
		type ModeFactory = { InteractiveMode: () => interactiveModeModule.InteractiveMode };
		const modeCtor = vi
			.spyOn(interactiveModeModule as unknown as ModeFactory, "InteractiveMode")
			.mockImplementation(function (this: unknown) {
				return makeFakeMode() as unknown as interactiveModeModule.InteractiveMode;
			});
		const runtime = await createAgentSessionRuntime({
			cwd: process.cwd(),
			sessionId: "hosted",
			createSession: async options => {
				const session = {
					sessionId: "hosted",
					isStreaming: false,
					subscribe: () => () => {},
					subscribeCommandMetadataChanged: () => () => {},
					settings: { get: () => undefined },
					sessionManager: { getCwd: () => process.cwd() },
					dispose: async () => {
						await options.sessionManager?.close();
					},
				} as unknown as AgentSession;
				return { session, setToolUIContext: () => {} } as unknown as CreateAgentSessionResult;
			},
		});
		const descriptor = { columns: 80, rows: 24 } as HostedTerminalDescriptor;
		try {
			await runtime.command({ type: "terminal_start", terminal: descriptor }, "a1");
			expect(modeCtor).toHaveBeenCalledTimes(1);

			// Server-observed drop: the registry's fire-and-forget detach put the
			// hosted mode into shutdown, but its task stays pinned (in-flight turn).
			modes[0]!.isShuttingDown = true;
			// Same attachment reconnects. Pre-fix this either no-oped (same id =>
			// permanently blank screen) or awaited the pinned task (hang); now it
			// must hand over promptly.
			await runtime.command({ type: "terminal_start", terminal: descriptor }, "a1");
			expect(modeCtor).toHaveBeenCalledTimes(2);
			expect(modes[0]!.detachHosted).toHaveBeenCalled();

			// A different attachment replaces the interactive terminal while the
			// current host is healthy (registry already rebound the attachment).
			await runtime.command({ type: "terminal_start", terminal: descriptor }, "a2");
			expect(modeCtor).toHaveBeenCalledTimes(3);
			expect(modes[1]!.detachHosted).toHaveBeenCalled();

			// A healthy same-id restart stays a no-op so an unnoticed transport
			// blip does not reset the TUI.
			await runtime.command({ type: "terminal_start", terminal: descriptor }, "a2");
			expect(modeCtor).toHaveBeenCalledTimes(3);
		} finally {
			await runtime.dispose();
		}
	});
});
