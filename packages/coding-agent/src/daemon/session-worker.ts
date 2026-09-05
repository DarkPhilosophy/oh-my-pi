/**
 * Per-session worker isolation for the daemon.
 *
 * The daemon's main thread owns sockets, the session registry, and event
 * fan-out. Everything a session does — the agent loop, transcript persistence,
 * the hosted TUI renderer — runs in a dedicated Bun `Worker` so a synchronous
 * stall in one session can no longer freeze every attached client. The main
 * thread sees a {@link DaemonSessionRuntime} proxy; the worker hosts the real
 * runtime built by {@link createAgentSessionRuntime}.
 *
 * Wire: structured-clone messages over `postMessage`.
 * - main → worker: `init`, `req` (snapshot/command/dispose/…), `ctlres`, `server`.
 * - worker → main: `ready`, `event`, `state`, `res`, `ctl`.
 */
import { parentPort } from "node:worker_threads";
import { logger, type postmortem } from "@oh-my-pi/pi-utils";
import { consumeWorkerInbox, workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import type { AgentSessionEventListener } from "../session/agent-session";
import {
	createAgentSessionRuntime,
	createDaemonSessionBaseResources,
	type CreateAgentSessionRuntimeOptions,
	type DaemonSessionCreateOverrides,
	type DaemonSessionRuntime,
	type DaemonSessionSnapshot,
	type DaemonSession,
	type HostedServerControls,
} from "./session-runtime";
import type { DaemonConnectionSnapshot } from "./status";

export const DAEMON_SESSION_WORKER_ARG = "__omp_worker_daemon_session";

/** Worker teardown budget after `dispose` before the thread is terminated outright. */
const DISPOSE_TIMEOUT_MS = 10_000;
/** How often the proxy refreshes the worker's view of transport backlog + server status. */
const SERVER_SYNC_INTERVAL_MS = 100;

type WorkerInit = {
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	sessionDir?: string;
	overrides?: DaemonSessionCreateOverrides;
	serverSnapshot: DaemonConnectionSnapshot;
};

type ShutdownResult = { shutdown?: boolean; blockers?: string[] } | undefined;

type ControlOp = "sessions" | "reconnect" | "stop" | "kill" | "refresh";

type ToWorker =
	| { t: "init"; init: WorkerInit }
	| { t: "req"; id: number; op: "snapshot" }
	| { t: "req"; id: number; op: "command"; command: unknown; attachmentId?: string }
	| { t: "req"; id: number; op: "dispose"; reason?: postmortem.Reason }
	| { t: "req"; id: number; op: "requestClientExit" }
	| { t: "req"; id: number; op: "protectedJobCount" }
	| { t: "ctlres"; id: number; ok: true; result: unknown }
	| { t: "ctlres"; id: number; ok: false; error: string }
	| { t: "server"; backlogBytes: number; snapshot?: DaemonConnectionSnapshot };

type WorkerRequest = Extract<ToWorker, { t: "req" }>;
type WorkerRequestBody = WorkerRequest extends infer R
	? R extends { id: number }
		? Omit<R, "id" | "t">
		: never
	: never;
type WorkerState = { isStreaming: boolean; sessionId: string; sessionFile?: string; cwd: string };

type FromWorker =
	| { t: "ready"; state: WorkerState }
	| { t: "failed"; error: string }
	| { t: "event"; event: unknown }
	| { t: "state"; state: WorkerState }
	| { t: "res"; id: number; ok: true; result: unknown }
	| { t: "res"; id: number; ok: false; error: string }
	| { t: "ctl"; id: number; op: ControlOp; force?: boolean };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ───────────────────────────── worker side ─────────────────────────────

/** Builds the in-worker runtime from the transferred init payload. */
export type WorkerRuntimeFactory = (
	options: Omit<CreateAgentSessionRuntimeOptions, "createSession" | "baseOptions">,
) => Promise<DaemonSessionRuntime>;

const defaultWorkerRuntimeFactory: WorkerRuntimeFactory = async options => {
	const resources = await createDaemonSessionBaseResources();
	return createAgentSessionRuntime({ ...options, baseOptions: resources.baseOptions });
};

/**
 * Entry for the `__omp_worker_daemon_session` selector: hosts one session
 * runtime. `runtimeFactory` lets a fixture worker host a scripted runtime.
 */
export async function runDaemonSessionWorker(
	runtimeFactory: WorkerRuntimeFactory = defaultWorkerRuntimeFactory,
): Promise<void> {
	const port = parentPort;
	if (!port) throw new Error("daemon session worker requires parentPort");
	const post = (message: FromWorker): void => port.postMessage(message);

	let runtime: DaemonSessionRuntime | undefined;
	let backlogBytes = 0;
	let serverSnapshot: DaemonConnectionSnapshot | undefined;
	let nextControlId = 0;
	const controls = new Map<number, PromiseWithResolvers<unknown>>();
	let lastState: string | undefined;

	const control = (op: ControlOp, force?: boolean): Promise<unknown> => {
		const id = ++nextControlId;
		const pending = Promise.withResolvers<unknown>();
		controls.set(id, pending);
		post({ t: "ctl", id, op, force });
		return pending.promise.finally(() => controls.delete(id));
	};
	const currentState = (): WorkerState | undefined => {
		if (!runtime) return undefined;
		return {
			isStreaming: runtime.session.isStreaming === true,
			sessionId: runtime.session.sessionId ?? runtime.sessionId,
			sessionFile: runtime.session.sessionFile,
			cwd: runtime.cwd,
		};
	};
	const publishState = (): void => {
		const state = currentState();
		if (!state) return;
		const key = `${state.isStreaming}\0${state.sessionId}\0${state.sessionFile ?? ""}\0${state.cwd}`;
		if (key === lastState) return;
		lastState = key;
		post({ t: "state", state });
	};

	const serverControls: HostedServerControls = {
		getSnapshot: () => {
			if (!serverSnapshot) throw new Error("daemon session worker has no server snapshot yet");
			return serverSnapshot;
		},
		sessions: () => control("sessions") as Promise<string>,
		reconnect: () => control("reconnect") as Promise<void>,
		stop: force => control("stop", force) as Promise<ShutdownResult>,
		kill: force => control("kill", force) as Promise<ShutdownResult>,
		refresh: force => control("refresh", force) as Promise<ShutdownResult>,
	};

	const init = async (message: WorkerInit): Promise<void> => {
		serverSnapshot = message.serverSnapshot;
		const built = await runtimeFactory({
			cwd: message.cwd,
			sessionId: message.sessionId,
			sessionFile: message.sessionFile,
			sessionDir: message.sessionDir,
			overrides: message.overrides,
			serverControls,
		});
		built.setTerminalOutputBacklog?.(() => backlogBytes);
		built.subscribe(event => {
			post({ t: "event", event });
			publishState();
		});
		runtime = built;
		const state = currentState();
		if (!state) throw new Error("daemon session runtime produced no state");
		lastState = `${state.isStreaming}\0${state.sessionId}\0${state.sessionFile ?? ""}\0${state.cwd}`;
		post({ t: "ready", state });
	};

	const handleRequest = async (message: Extract<ToWorker, { t: "req" }>): Promise<void> => {
		if (!runtime) {
			post({ t: "res", id: message.id, ok: false, error: "daemon session runtime is not initialized" });
			return;
		}
		try {
			let result: unknown;
			switch (message.op) {
				case "snapshot":
					result = await runtime.snapshot();
					break;
				case "command":
					result = await runtime.command(message.command, message.attachmentId);
					break;
				case "dispose":
					await runtime.dispose(message.reason);
					break;
				case "requestClientExit":
					runtime.requestClientExit?.();
					break;
				case "protectedJobCount":
					result = runtime.protectedJobCount?.() ?? 0;
					break;
			}
			publishState();
			post({ t: "res", id: message.id, ok: true, result });
		} catch (error) {
			post({ t: "res", id: message.id, ok: false, error: errorMessage(error) });
		}
	};

	const handle = (data: unknown): void => {
		const message = data as ToWorker;
		switch (message.t) {
			case "init":
				void init(message.init).catch(error => {
					logger.error("Daemon session worker init failed", { error: errorMessage(error) });
					post({ t: "failed", error: errorMessage(error) });
				});
				return;
			case "req":
				void handleRequest(message);
				return;
			case "ctlres": {
				const pending = controls.get(message.id);
				if (!pending) return;
				if (message.ok) pending.resolve(message.result);
				else pending.reject(new Error(message.error));
				return;
			}
			case "server":
				backlogBytes = message.backlogBytes;
				if (message.snapshot) serverSnapshot = message.snapshot;
				return;
		}
	};

	// The CLI host installs a buffering inbox before importing this module so
	// the parent's `init` (posted right after spawn) is not lost to Bun's
	// pre-listener flush; a direct module load binds the port itself.
	const inbox = consumeWorkerInbox();
	if (inbox) inbox.bind(handle);
	else port.on("message", handle);
}

// ───────────────────────────── main-thread side ─────────────────────────────

type WorkerRuntimeOptions = CreateAgentSessionRuntimeOptions & {
	/** Main-thread implementations of the controls the hosted TUI may invoke. */
	serverControls: HostedServerControls;
};

/** Spawns the worker thread; overridable so tests can host a fixture runtime. */
export type SessionWorkerSpawner = () => Worker;

export function spawnSessionWorker(): Worker {
	const hostEntry = workerHostEntry();
	return hostEntry
		? new Worker(hostEntry, { type: "module", argv: [DAEMON_SESSION_WORKER_ARG] })
		: new Worker(new URL("./session-worker-entry.ts", import.meta.url).href, { type: "module" });
}

/** Spawn a session worker and return the main-thread {@link DaemonSessionRuntime} proxy for it. */
export async function createWorkerSessionRuntime(
	options: WorkerRuntimeOptions,
	spawn: SessionWorkerSpawner = spawnSessionWorker,
): Promise<DaemonSessionRuntime> {
	const worker = spawn();
	const listeners = new Set<AgentSessionEventListener>();
	const pending = new Map<number, PromiseWithResolvers<unknown>>();
	let nextRequestId = 0;
	let closed = false;
	let exited = false;
	const ready = Promise.withResolvers<WorkerState>();
	const view = {
		sessionId: options.sessionId ?? "",
		sessionFile: options.sessionFile,
		isStreaming: false,
		cwd: options.cwd,
	};
	const controls = options.serverControls;

	const request = (body: WorkerRequestBody): Promise<unknown> => {
		if (exited) return Promise.reject(new Error("daemon session worker has exited"));
		const id = ++nextRequestId;
		const settle = Promise.withResolvers<unknown>();
		pending.set(id, settle);
		worker.postMessage({ t: "req", id, ...body } as WorkerRequest);
		return settle.promise.finally(() => pending.delete(id));
	};
	const applyState = (state: WorkerState): void => {
		view.isStreaming = state.isStreaming;
		view.sessionId = state.sessionId;
		view.sessionFile = state.sessionFile;
		view.cwd = state.cwd;
	};
	const emit = (event: unknown): void => {
		for (const listener of listeners) {
			try {
				listener(event as never);
			} catch (error) {
				logger.warn("Daemon session worker listener failed", { error: errorMessage(error) });
			}
		}
	};
	const failAll = (error: Error): void => {
		for (const settle of pending.values()) settle.reject(error);
		pending.clear();
		ready.reject(error);
	};
	const runControl = async (message: Extract<FromWorker, { t: "ctl" }>): Promise<void> => {
		try {
			let result: unknown;
			switch (message.op) {
				case "sessions":
					result = await controls.sessions?.();
					break;
				case "reconnect":
					await controls.reconnect?.();
					break;
				case "stop":
					result = await controls.stop?.(message.force);
					break;
				case "kill":
					result = await controls.kill?.(message.force);
					break;
				case "refresh":
					result = await controls.refresh?.(message.force);
					break;
			}
			worker.postMessage({ t: "ctlres", id: message.id, ok: true, result } satisfies ToWorker);
		} catch (error) {
			worker.postMessage({ t: "ctlres", id: message.id, ok: false, error: errorMessage(error) } satisfies ToWorker);
		}
	};
	const onExit = (error: Error): void => {
		if (exited) return;
		exited = true;
		stopServerSync();
		failAll(error);
		view.isStreaming = false;
		if (closed) return;
		// The worker died underneath a live session: attached clients must
		// leave the hosted terminal instead of waiting on output that will
		// never come. The registry closes the record on this event.
		emit({
			type: "terminal_closed",
			reason: "error",
			sessionId: view.sessionId,
			sessionFile: view.sessionFile,
			error: error.message,
		});
	};

	worker.onmessage = (event: MessageEvent<FromWorker>) => {
		const message = event.data;
		switch (message.t) {
			case "ready":
				applyState(message.state);
				ready.resolve(message.state);
				return;
			case "failed":
				ready.reject(new Error(message.error));
				return;
			case "event":
				emit(message.event);
				return;
			case "state":
				applyState(message.state);
				return;
			case "res": {
				const settle = pending.get(message.id);
				if (!settle) return;
				if (message.ok) settle.resolve(message.result);
				else settle.reject(new Error(message.error));
				return;
			}
			case "ctl":
				void runControl(message);
				return;
		}
	};
	worker.onerror = event => {
		const error = event.error instanceof Error ? event.error : new Error(String(event.message ?? "worker error"));
		logger.error("Daemon session worker crashed", { sessionId: view.sessionId, error: error.message });
		onExit(error);
		worker.terminate();
	};
	worker.addEventListener("close", () => onExit(new Error("daemon session worker exited")));

	// Backlog + server status are pulled by the worker's renderer synchronously,
	// so the proxy pushes them: immediately on change, at most every tick.
	let backlog: () => number = () => 0;
	let lastBacklog = -1;
	let lastSnapshotKey = "";
	let syncTimer: ReturnType<typeof setInterval> | undefined;
	const syncServer = (): void => {
		if (exited) return;
		const backlogBytes = backlog();
		const snapshot = controls.getSnapshot();
		const snapshotKey = JSON.stringify(snapshot);
		if (backlogBytes === lastBacklog && snapshotKey === lastSnapshotKey) return;
		lastBacklog = backlogBytes;
		const snapshotChanged = snapshotKey !== lastSnapshotKey;
		lastSnapshotKey = snapshotKey;
		worker.postMessage({
			t: "server",
			backlogBytes,
			...(snapshotChanged ? { snapshot } : {}),
		} satisfies ToWorker);
	};
	const stopServerSync = (): void => {
		if (syncTimer) clearInterval(syncTimer);
		syncTimer = undefined;
	};

	const init: WorkerInit = {
		cwd: options.cwd,
		sessionId: options.sessionId,
		sessionFile: options.sessionFile,
		sessionDir: options.sessionDir,
		overrides: options.overrides,
		serverSnapshot: controls.getSnapshot(),
	};
	lastSnapshotKey = JSON.stringify(init.serverSnapshot);
	worker.postMessage({ t: "init", init } satisfies ToWorker);
	try {
		await ready.promise;
	} catch (error) {
		closed = true;
		exited = true;
		worker.terminate();
		throw error;
	}
	syncTimer = setInterval(syncServer, SERVER_SYNC_INTERVAL_MS);
	syncTimer.unref?.();

	const subscribe = (listener: AgentSessionEventListener): (() => void) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	};
	const commandOnWorker = (command: unknown): Promise<unknown> => request({ op: "command", command });
	// Registry-facing session surface. Mutating entry points route through the
	// worker's command dispatcher; identity/streaming fields mirror worker state.
	const session: DaemonSession = {
		get sessionId() {
			return view.sessionId;
		},
		get sessionFile() {
			return view.sessionFile;
		},
		get isStreaming() {
			return view.isStreaming;
		},
		prompt: async (message, promptOptions) => {
			await commandOnWorker({ type: "prompt", message, images: promptOptions?.images });
			return true;
		},
		abort: async () => {
			await commandOnWorker({ type: "abort" });
		},
		dispose: async () => {
			await proxy.dispose();
		},
		subscribe,
	};
	const proxy: DaemonSessionRuntime = {
		get sessionId() {
			return view.sessionId;
		},
		get cwd() {
			return view.cwd;
		},
		session,
		protectedJobCount: () => 0,
		requestClientExit: () => {
			void request({ op: "requestClientExit" }).catch(() => undefined);
		},
		setTerminalOutputBacklog: pendingBytes => {
			backlog = pendingBytes;
			syncServer();
		},
		snapshot: () => request({ op: "snapshot" }) as Promise<DaemonSessionSnapshot>,
		command: (command, attachmentId) => request({ op: "command", command, attachmentId }),
		subscribe,
		dispose: async reason => {
			if (closed) return;
			closed = true;
			stopServerSync();
			if (!exited) {
				const timeout = Bun.sleep(DISPOSE_TIMEOUT_MS).then(() => {
					throw new Error("daemon session worker dispose timed out");
				});
				await Promise.race([request({ op: "dispose", reason }), timeout]).catch(error => {
					logger.warn("Daemon session worker dispose failed", {
						sessionId: view.sessionId,
						error: errorMessage(error),
					});
				});
			}
			exited = true;
			failAll(new Error("daemon session worker disposed"));
			worker.terminate();
		},
	};
	return proxy;
}
