import { ProcessTerminal } from "@oh-my-pi/pi-tui";
import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { getActiveProfile, getProjectDir } from "@oh-my-pi/pi-utils/dirs";
import { type Args, parseArgs } from "../cli/args";
import { selectSession } from "../cli/session-picker";
import { applyStartupCwd } from "../cli/startup-cwd";
import { initTheme, stopThemeWatcher } from "../modes/theme/theme";
import { RemoteSessionHandle, type SessionHandleCommand } from "../session/session-handle";
import { resolveResumableSession } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { createDaemonClient, type DaemonClient } from "./client";
import type { DaemonConnectionSnapshot } from "./status";
import { ClientTerminalBridge } from "./terminal-bridge";

const DAEMON_SERVER_WORKER_ARG = "__omp_worker_daemon_server";
const CONNECT_RETRY_MS = 50;
const DAEMON_START_TIMEOUT_MS = 15_000;

export type DaemonInteractiveBootstrapOptions = {
	argv: string[];
	profile?: string;
	projectRoot?: string;
	runtimeDir?: string;
	endpoint?: string;
	token?: string;
	connectTimeoutMs?: number;
	startTimeoutMs?: number;
};

export type DaemonInteractiveSession = {
	client: DaemonClient;
	handle: RemoteSessionHandle;
	snapshot: () => DaemonConnectionSnapshot;
	sessions: () => Promise<string>;
	reconnect: () => Promise<void>;
	stop: () => Promise<{ shutdown?: boolean; blockers?: string[] } | undefined>;
};

function launchArgs(argv: readonly string[]): string[] {
	return argv[0] === "launch" ? [...argv.slice(1)] : [...argv];
}
const NON_INTERACTIVE_COMMANDS: Record<string, true> = {
	acp: true,
	"auth-broker": true,
	"auth-gateway": true,
	agents: true,
	bench: true,
	commit: true,
	completions: true,
	__complete: true,
	config: true,
	"dry-balance": true,
	gc: true,
	grep: true,
	gallery: true,
	grievances: true,
	install: true,
	join: true,
	models: true,
	plugin: true,
	say: true,
	setup: true,
	shell: true,
	read: true,
	ssh: true,
	stats: true,
	update: true,
	usage: true,
	"tiny-models": true,
	token: true,
	ttsr: true,
	worktree: true,
	wt: true,
	search: true,
	q: true,
};

/** Return whether argv is the default interactive launch path. */
export function isDefaultInteractiveArgv(argv: readonly string[]): boolean {
	const first = argv[0];
	if (first !== undefined && first !== "launch" && !first.startsWith("-") && NON_INTERACTIVE_COMMANDS[first])
		return false;
	if (argv.includes("--no-daemon")) return false;
	let parsed: Args;
	try {
		parsed = parseArgs(launchArgs(argv));
	} catch {
		return false;
	}
	if (parsed.help || parsed.version || parsed.print || parsed.export) return false;
	if (parsed.mode !== undefined && parsed.mode !== "text") return false;
	return true;
}

export async function resolveDaemonInteractiveResume(
	options: DaemonInteractiveBootstrapOptions,
): Promise<DaemonInteractiveBootstrapOptions | undefined> {
	const parsed = parseArgs(launchArgs(options.argv));
	if (parsed.resume === undefined) return options;
	await applyStartupCwd(parsed);
	const cwd = options.projectRoot ?? getProjectDir();
	if (typeof parsed.resume === "string") {
		const match = await resolveResumableSession(parsed.resume, cwd, parsed.sessionDir);
		if (
			match?.scope !== "global" ||
			normalizePathForComparison(match.session.cwd || cwd) === normalizePathForComparison(cwd)
		)
			return options;
		const forked = await SessionManager.forkFrom(match.session.path, cwd, parsed.sessionDir);
		const forkedPath = forked.getSessionFile();
		if (!forkedPath) throw new Error(`Unable to fork session "${parsed.resume}" into ${cwd}`);
		const argv = [...options.argv];
		const resumeIndex = argv.findIndex(
			argument => argument === "--resume" || argument === "-r" || argument === "--session",
		);
		if (resumeIndex < 0) throw new Error("Unable to locate resume argument");
		argv.splice(resumeIndex, 2, "--resume", forkedPath);
		return { ...options, argv, projectRoot: cwd };
	}
	const folderSessions = await SessionManager.list(cwd, parsed.sessionDir);
	const allSessions = folderSessions.length === 0 ? await SessionManager.listAll() : undefined;
	await initTheme();
	const selected = await selectSession(folderSessions, { allSessions }).finally(stopThemeWatcher);
	if (!selected) return undefined;
	const argv = [...options.argv];
	const resumeIndex = argv.findIndex(
		argument => argument === "--resume" || argument === "-r" || argument === "--session",
	);
	if (resumeIndex < 0) throw new Error("Unable to locate bare resume argument");
	argv.splice(resumeIndex, 1, "--resume", selected.path);
	return {
		...options,
		argv,
		projectRoot: selected.cwd ?? cwd,
	};
}

function createSessionOverrides(argv: readonly string[]): Record<string, unknown> {
	return { argv: [...argv] };
}

type SpawnedDaemonServer = {
	readonly exited: Promise<number>;
	readonly exitCode: number | null;
	unref(): void;
};

function spawnDaemonServer(
	profile: string,
	projectRoot: string,
	runtimeDir?: string,
	stderr: "inherit" | "ignore" = "inherit",
): SpawnedDaemonServer {
	const spawn = resolveWorkerSpawnCmd(DAEMON_SERVER_WORKER_ARG);
	const env: Record<string, string> = {
		OMP_PROFILE: profile,
		OMP_DAEMON_PROJECT_ROOT: projectRoot,
		OMP_DAEMON_PROJECT_DIR: projectRoot,
	};
	if (runtimeDir !== undefined) env.OMP_DAEMON_RUNTIME_DIR = runtimeDir;
	return Bun.spawn(spawn.cmd, {
		cwd: spawn.cwd,
		env: workerEnvFromParent(env),
		stdin: "ignore",
		stdout: "ignore",
		stderr,
		detached: true,
	});
}

function isTransportUnavailableError(error: unknown): boolean {
	const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
	if (code === "ENOENT" || code === "ECONNREFUSED") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /\b(?:ENOENT|ECONNREFUSED)\b|socket is unavailable/i.test(message);
}

function isTerminalConnectionError(client: DaemonClient, error: unknown): boolean {
	if (client.snapshot.state === "incompatible") return true;
	const message = error instanceof Error ? error.message : String(error);
	return /auth|token|scope|shard|protocol|invalid|unsupported|incompatible/i.test(message);
}

async function connectWithSpawn(
	client: DaemonClient,
	profile: string,
	projectRoot: string,
	runtimeDir: string | undefined,
	startTimeoutMs: number,
): Promise<void> {
	try {
		await client.connect();
		return;
	} catch (firstError) {
		const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
		if (isTerminalConnectionError(client, firstError)) {
			throw new Error(`Daemon connection is terminal: ${firstMessage}`);
		}
		if (!isTransportUnavailableError(firstError)) {
			throw new Error(`Daemon connection failed before startup: ${firstMessage}`);
		}
		const child = spawnDaemonServer(profile, projectRoot, runtimeDir);
		const deadline = Date.now() + startTimeoutMs;
		let lastError = firstError instanceof Error ? firstError : new Error(String(firstError));
		while (Date.now() < deadline) {
			if (child.exitCode !== null) {
				throw new Error(`Daemon server exited during startup with code ${child.exitCode}`);
			}
			try {
				await client.connect();
				child.unref();
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				if (isTerminalConnectionError(client, lastError))
					throw new Error(`Daemon connection is terminal: ${lastError.message}`);
				await Bun.sleep(CONNECT_RETRY_MS);
			}
		}
		throw new Error(`Unable to connect to daemon: ${lastError.message}`);
	}
}

/**
 * Connect to (or start) the authenticated per-project daemon and attach one
 * interactive session. This module deliberately imports the interactive UI
 * only after the daemon handshake so the default route never loads main.ts or
 * the command graph before the connection is established.
 */
export async function bootstrapDaemonInteractive(
	options: DaemonInteractiveBootstrapOptions,
): Promise<DaemonInteractiveSession> {
	const parsed = parseArgs(launchArgs(options.argv));
	await applyStartupCwd(parsed);
	const profile = options.profile ?? getActiveProfile() ?? "default";
	const projectRoot = options.projectRoot ?? getProjectDir();
	let recoveryRuntimeDir = options.runtimeDir;
	const client = await createDaemonClient({
		profile,
		projectRoot,
		runtimeDir: options.runtimeDir,
		endpoint: options.endpoint,
		token: options.token,
		connectTimeoutMs: options.connectTimeoutMs,
		recoverUnavailable: () => {
			spawnDaemonServer(profile, projectRoot, recoveryRuntimeDir, "ignore").unref();
		},
	});
	recoveryRuntimeDir = client.runtimeDir;
	await connectWithSpawn(
		client,
		profile,
		client.projectRoot,
		client.runtimeDir,
		options.startTimeoutMs ?? DAEMON_START_TIMEOUT_MS,
	);

	const createOperation = {
		op: "session_create",
		cwd: client.projectRoot,
		overrides: createSessionOverrides(launchArgs(options.argv)),
	} as const;
	const created = (await client.request(createOperation)) as { sessionId?: unknown };
	if (typeof created.sessionId !== "string" || created.sessionId.length === 0) {
		client.close();
		throw new Error("Daemon did not return a session id");
	}
	const sessionId = created.sessionId;
	const handle = new RemoteSessionHandle(client, sessionId, {
		recover: async () => {
			await client.request({ ...createOperation, sessionId });
		},
	});
	await handle.whenReady();
	return {
		client,
		handle,
		snapshot: () => client.snapshot,
		sessions: async () => JSON.stringify(await client.request("session_list")),
		reconnect: () => client.reconnect(),
		stop: async () => {
			const result = (await client.request("shutdown")) as { shutdown?: boolean; blockers?: string[] };
			if (result.shutdown === true) client.close();
			return result;
		},
	};
}
/** Launch the complete existing OMP interactive mode hosted by the daemon. */
export async function launchDaemonInteractive(options: DaemonInteractiveBootstrapOptions): Promise<void> {
	const resolvedOptions = await resolveDaemonInteractiveResume(options);
	if (!resolvedOptions) return;
	const session = await bootstrapDaemonInteractive(resolvedOptions);
	const terminal = new ProcessTerminal();
	const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
	let hostReady = false;
	let pendingInput = "";
	let pendingSize = { columns: terminal.columns, rows: terminal.rows };
	let pendingAppearance = terminal.appearance;
	let commandChain = Promise.resolve();
	const enqueue = (command: SessionHandleCommand): void => {
		commandChain = commandChain
			.then(() => session.handle.command(command))
			.then(() => undefined)
			.catch(() => undefined);
	};
	const bridge = new ClientTerminalBridge(terminal, {
		onInput: data => {
			if (hostReady) enqueue({ type: "terminal_input", data });
			else pendingInput += data;
		},
		onResize: size => {
			pendingSize = size;
			if (hostReady) enqueue({ type: "terminal_resize", size });
		},
		onAppearance: appearance => {
			pendingAppearance = appearance;
			if (hostReady) enqueue({ type: "terminal_appearance", appearance });
		},
	});
	const unsubscribeEvents = session.handle.subscribe(event => {
		if (event.type === "terminal_output") bridge.output(event.data);
		else if (event.type === "terminal_closed" && (event.reason === "exit" || event.reason === "error"))
			resolveClosed();
	});
	let startTask: Promise<void> | undefined;
	const startHost = (): Promise<void> => {
		if (startTask) return startTask;
		hostReady = false;
		startTask = (async () => {
			await session.handle.command({
				type: "terminal_start",
				terminal: {
					columns: terminal.columns,
					rows: terminal.rows,
					kittyProtocolActive: terminal.kittyProtocolActive,
					kittyEnableSequence: terminal.kittyEnableSequence,
					keyboardEnhancementEnterSequence: terminal.keyboardEnhancementEnterSequence,
					keyboardEnhancementExitSequence: terminal.keyboardEnhancementExitSequence,
					appearance: terminal.appearance,
				},
			});
			hostReady = true;
			enqueue({ type: "terminal_resize", size: pendingSize });
			if (pendingAppearance) enqueue({ type: "terminal_appearance", appearance: pendingAppearance });
			if (pendingInput) {
				const data = pendingInput;
				pendingInput = "";
				enqueue({ type: "terminal_input", data });
			}
		})().finally(() => {
			startTask = undefined;
		});
		return startTask;
	};
	const unsubscribeConnection = session.client.onSnapshot(snapshot => {
		if (snapshot.state === "connected") void startHost().catch(() => undefined);
		else hostReady = false;
	});
	try {
		bridge.start();
		pendingSize = { columns: terminal.columns, rows: terminal.rows };
		pendingAppearance = terminal.appearance;
		await startHost();
		await closed;
	} finally {
		unsubscribeConnection();
		unsubscribeEvents();
		if (session.handle.connectionState === "connected") {
			await session.handle.command({ type: "terminal_detach" }).catch(() => undefined);
		}
		await bridge.stop();
		if (session.handle.connectionState !== "detached") await session.handle.dispose().catch(() => undefined);
		session.client.close();
	}
}
