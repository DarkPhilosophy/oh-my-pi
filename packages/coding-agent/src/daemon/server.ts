import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { MCPManagerPool } from "../mcp";
import { type CreateAgentSessionOptions, discoverAuthStorage } from "../sdk";
import { SessionManager } from "../session/session-manager";
import {
	canonicalProjectRoot,
	daemonEndpoint,
	daemonRuntimeDir,
	ensureDaemonRuntimeDir,
	readOrCreateDaemonToken,
} from "./paths";
import {
	DAEMON_MAX_FRAME_BYTES,
	DAEMON_PROTOCOL_MAJOR,
	type DaemonErrorCode,
	type DaemonFrame,
	type DaemonHello,
	type DaemonOperation,
	DaemonProtocolError,
	type DaemonRequest,
	type DaemonServerStatus,
	decodeDaemonFrame,
	encodeDaemonFrame,
} from "./protocol";
import { DaemonSessionRegistry, RegistryError } from "./session-registry";
import {
	createAgentSessionRuntime,
	type DaemonSessionRuntimeFactory,
	type HostedServerControls,
} from "./session-runtime";

const SERVER_VERSION = "1";
const DEFAULT_MAX_CLIENTS = 64;
const OWNER_FILE = "daemon.owner";
const SKIP_DISPATCH = Symbol("skip daemon dispatch");

type Connection = {
	socket: net.Socket;
	buffer: string;
	authenticated: boolean;
	attachments: Set<string>;
	requestIds: Set<string>;
	closed: boolean;
	generation: number;
};

export type DaemonServerOptions = {
	profile: string;
	projectRoot: string;
	runtimeDir?: string;
	endpoint?: string;
	token?: string;
	daemonId?: string;
	serverVersion?: string;
	runtimeFactory?: DaemonSessionRuntimeFactory;
	registry?: DaemonSessionRegistry;
	now?: () => number;
	maxClients?: number;
	sessionDir?: string;
};

export type DaemonShutdownResult = {
	shutdown: boolean;
	blockers: Array<"clients" | "sessions" | "protected_jobs">;
};

function unknownErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): DaemonErrorCode {
	if (error instanceof RegistryError) return error.code;
	if (error instanceof DaemonProtocolError) return error.code;
	return "internal";
}

function requestIdOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !("requestId" in value)) return undefined;
	const requestId = value.requestId;
	return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}

function constantTimeTokenEquals(expected: string, provided: string): boolean {
	const left = Buffer.from(expected, "utf8");
	const right = Buffer.from(provided, "utf8");
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function frameType(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) return undefined;
	const type = value.type;
	return typeof type === "string" ? type : undefined;
}

function frameSeq(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !("seq" in value)) return undefined;
	const seq = value.seq;
	return typeof seq === "number" && Number.isInteger(seq) ? seq : undefined;
}

/** Authenticated per-profile/project Unix socket daemon. */
export class DaemonServer {
	readonly profile: string;
	readonly #configuredProjectRoot: string;
	#canonicalProjectRoot: string | undefined;
	readonly #runtimeDirOverride: string | undefined;
	readonly #endpointOverride: string | undefined;
	readonly #tokenOverride: string | undefined;
	readonly #daemonId: string;
	readonly #serverVersion: string;
	readonly #runtimeFactory: DaemonSessionRuntimeFactory;
	readonly #registryOverride: DaemonSessionRegistry | undefined;
	readonly #now: () => number;
	readonly #maxClients: number;
	readonly #sessionDir: string | undefined;
	readonly #usesDefaultRuntimeFactory: boolean;
	readonly #startedAt: number;
	readonly #connections = new Set<Connection>();
	#requestQueue: Promise<void> = Promise.resolve();
	#registry: DaemonSessionRegistry | undefined;
	#server: net.Server | undefined;
	#runtimeDir: string | undefined;
	#endpoint: string | undefined;
	#token: string | undefined;
	#closed = false;
	#ownerHandle: fs.FileHandle | undefined;
	#ownerPath: string | undefined;
	#shutdownPromise: Promise<DaemonShutdownResult> | undefined;
	#sharedAuthStorage: AuthStorage | undefined;
	#sharedMcpManagerPool: MCPManagerPool | undefined;
	#sessionBaseOptions: CreateAgentSessionOptions | undefined;

	constructor(options: DaemonServerOptions) {
		this.profile = options.profile;
		this.#configuredProjectRoot = options.projectRoot;
		this.#runtimeDirOverride = options.runtimeDir;
		this.#endpointOverride = options.endpoint;
		this.#tokenOverride = options.token;
		this.#daemonId = options.daemonId ?? crypto.randomUUID();
		this.#serverVersion = options.serverVersion ?? SERVER_VERSION;
		this.#runtimeFactory = options.runtimeFactory ?? createAgentSessionRuntime;
		this.#usesDefaultRuntimeFactory = options.runtimeFactory === undefined;
		this.#registryOverride = options.registry;
		this.#now = options.now ?? Date.now;
		this.#maxClients = Math.max(1, Math.trunc(options.maxClients ?? DEFAULT_MAX_CLIENTS));
		this.#sessionDir = options.sessionDir;
		this.#startedAt = this.#now();
	}

	get registry(): DaemonSessionRegistry {
		if (!this.#registry) throw new Error("daemon server is not running");
		return this.#registry;
	}

	get endpoint(): string | undefined {
		return this.#endpoint;
	}

	get token(): string | undefined {
		return this.#token;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Start listening after runtime/token/socket permissions are established. */
	async run(): Promise<this> {
		if (this.#server) return this;
		const projectRoot = await canonicalProjectRoot(this.#configuredProjectRoot);
		this.#canonicalProjectRoot = projectRoot;
		this.#runtimeDir = this.#runtimeDirOverride ?? daemonRuntimeDir(this.profile, projectRoot);
		this.#endpoint = this.#endpointOverride ?? daemonEndpoint(this.#runtimeDir);
		await ensureDaemonRuntimeDir(this.#runtimeDir);
		this.#token = this.#tokenOverride ?? (await readOrCreateDaemonToken(this.#runtimeDir));
		await fs.chmod(this.#runtimeDir, 0o700);
		try {
			await this.#acquireOwnerLease();
			if (this.#usesDefaultRuntimeFactory) {
				const authStorage = await discoverAuthStorage();
				const mcpManagerPool = new MCPManagerPool();
				this.#sharedAuthStorage = authStorage;
				this.#sharedMcpManagerPool = mcpManagerPool;
				this.#sessionBaseOptions = {
					authStorage,
					modelRegistry: new ModelRegistry(authStorage),
					mcpManagerPool,
				};
			}
			const serverControls: HostedServerControls = {
				getSnapshot: () => {
					const status = this.status();
					return {
						state: "connected",
						shard: status.shard,
						daemonId: status.daemonId,
						serverVersion: status.serverVersion,
						protocolVersion: status.protocolVersion,
						sessionCount: status.sessionCount,
						attachmentCount: status.attachmentCount,
						protectedJobCount: status.protectedJobCount,
						uptimeMs: status.uptimeMs,
					};
				},
				sessions: () => JSON.stringify(this.registry.list()),
				reconnect: () => undefined,
				stop: () => ({
					shutdown: false,
					blockers: ["detach the current interactive session before stopping the server"],
				}),
			};
			this.#registry =
				this.#registryOverride ??
				new DaemonSessionRegistry({
					projectRoot,
					runtimeFactory: options =>
						this.#runtimeFactory({
							...options,
							baseOptions: { ...this.#sessionBaseOptions, ...options.baseOptions },
							serverControls,
						}),
					sessionDir: this.#sessionDir,
					listSessions: async cwd => SessionManager.list(cwd),
				});
			for (;;) {
				const server = net.createServer(socket => this.#accept(socket));
				this.#server = server;
				try {
					await new Promise<void>((resolve, reject) => {
						const onError = (error: Error): void => {
							server.off("listening", onListening);
							reject(error);
						};
						const onListening = (): void => {
							server.off("error", onError);
							resolve();
						};
						server.once("error", onError);
						server.once("listening", onListening);
						server.listen(this.#endpoint!);
					});
					break;
				} catch (error) {
					this.#server = undefined;
					await new Promise<void>(resolve => server.close(() => resolve()));
					const code = error instanceof Error && "code" in error ? error.code : undefined;
					if (code !== "EADDRINUSE" || (await this.#probeEndpoint())) throw error;
					await fs.rm(this.#endpoint!, { force: true });
				}
			}
			await fs.chmod(this.#endpoint!, 0o600);
			return this;
		} catch (error) {
			await this.#disposeSharedResources();
			await this.#releaseOwnerLease();
			throw error;
		}
	}
	async #acquireOwnerLease(): Promise<void> {
		const ownerPath = path.join(this.#runtimeDir!, OWNER_FILE);
		this.#ownerPath = ownerPath;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const handle = await fs.open(ownerPath, "wx", 0o600);
				await handle.writeFile(
					JSON.stringify({ pid: process.pid, daemonId: this.#daemonId, startedAt: this.#startedAt }),
					"utf8",
				);
				this.#ownerHandle = handle;
				return;
			} catch (error) {
				const code = error instanceof Error && "code" in error ? error.code : undefined;
				if (code !== "EEXIST") throw error;
				if (await this.#probeEndpoint()) throw new Error(`daemon endpoint is already owned: ${this.#endpoint}`);
				let ownerAlive = false;
				try {
					const owner = JSON.parse(await Bun.file(ownerPath).text()) as { pid?: unknown };
					if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
						try {
							process.kill(owner.pid, 0);
							ownerAlive = true;
						} catch (probeError) {
							const probeCode =
								probeError instanceof Error && "code" in probeError ? probeError.code : undefined;
							ownerAlive = probeCode !== "ESRCH";
						}
					}
				} catch (readError) {
					const readCode = readError instanceof Error && "code" in readError ? readError.code : undefined;
					if (readCode !== "ENOENT") ownerAlive = true;
				}
				if (ownerAlive) throw new Error(`daemon owner is still starting: ${this.#endpoint}`);
				await fs.rm(ownerPath, { force: true });
			}
		}
		throw new Error(`unable to acquire daemon owner lease: ${ownerPath}`);
	}

	async #probeEndpoint(): Promise<boolean> {
		const endpoint = this.#endpoint;
		const token = this.#token;
		const projectRoot = this.#canonicalProjectRoot;
		if (!endpoint || !token || !projectRoot) return false;
		return new Promise(resolve => {
			const socket = net.createConnection({ path: endpoint });
			let buffer = "";
			let settled = false;
			const finish = (healthy: boolean): void => {
				if (settled) return;
				settled = true;
				socket.destroy();
				resolve(healthy);
			};
			const timer = setTimeout(() => finish(false), 250);
			socket.setEncoding("utf8");
			socket.on("connect", () => {
				socket.write(
					encodeDaemonFrame({
						v: DAEMON_PROTOCOL_MAJOR,
						tag: "hello",
						requestId: `probe-${this.#daemonId}`,
						profile: this.profile,
						projectRoot,
						token,
					}),
				);
			});
			socket.on("data", chunk => {
				buffer += String(chunk);
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				clearTimeout(timer);
				try {
					const frame = decodeDaemonFrame(buffer.slice(0, newline));
					finish(frame.tag === "hello_ok");
				} catch {
					finish(false);
				}
			});
			socket.once("error", () => {
				clearTimeout(timer);
				finish(false);
			});
			socket.once("close", () => {
				clearTimeout(timer);
				finish(false);
			});
		});
	}

	async #releaseOwnerLease(): Promise<void> {
		const handle = this.#ownerHandle;
		const ownerPath = this.#ownerPath;
		this.#ownerHandle = undefined;
		this.#ownerPath = undefined;
		if (!handle || !ownerPath) return;
		await handle.close().catch(() => undefined);
		try {
			const owner = JSON.parse(await Bun.file(ownerPath).text()) as { daemonId?: unknown };
			if (owner.daemonId === this.#daemonId) await fs.rm(ownerPath, { force: true });
		} catch {
			// A stale-owner contender or external cleanup may already have removed it.
		}
	}

	status(): DaemonServerStatus {
		const counts = this.#registry?.status() ?? { sessionCount: 0, attachmentCount: 0, protectedJobCount: 0 };
		return {
			daemonId: this.#daemonId,
			serverVersion: this.#serverVersion,
			protocolVersion: DAEMON_PROTOCOL_MAJOR,
			shard: {
				profile: this.profile,
				projectRoot: this.#canonicalProjectRoot ?? path.resolve(this.#configuredProjectRoot),
			},
			sessionCount: counts.sessionCount,
			attachmentCount: counts.attachmentCount,
			protectedJobCount: counts.protectedJobCount,
			uptimeMs: Math.max(0, this.#now() - this.#startedAt),
		};
	}

	idleShutdownEligible(): boolean {
		return (
			this.#connections.size === 0 &&
			!this.#registry?.hasLiveSessions &&
			(this.#registry?.protectedJobCount ?? 0) === 0
		);
	}

	async #disposeSharedResources(): Promise<void> {
		const mcpManagerPool = this.#sharedMcpManagerPool;
		const authStorage = this.#sharedAuthStorage;
		this.#sharedMcpManagerPool = undefined;
		this.#sharedAuthStorage = undefined;
		this.#sessionBaseOptions = undefined;
		try {
			await mcpManagerPool?.dispose();
		} finally {
			authStorage?.close();
		}
	}

	async shutdown(force = false): Promise<DaemonShutdownResult> {
		if (this.#shutdownPromise) return this.#shutdownPromise;
		const blockers = this.#shutdownBlockers();
		if (blockers.length > 0 && !force) return { shutdown: false, blockers };
		this.#shutdownPromise = (async () => {
			this.#closed = true;
			for (const connection of [...this.#connections]) {
				connection.socket.destroy();
				this.#releaseConnection(connection);
			}
			try {
				await this.#registry?.dispose();
				const server = this.#server;
				this.#server = undefined;
				if (server) await new Promise<void>(resolve => server.close(() => resolve()));
				if (this.#endpoint) await fs.rm(this.#endpoint, { force: true });
				return { shutdown: true, blockers: [] };
			} finally {
				try {
					await this.#disposeSharedResources();
				} finally {
					await this.#releaseOwnerLease();
				}
			}
		})();
		return this.#shutdownPromise;
	}

	#shutdownBlockers(excluded?: Connection): Array<"clients" | "sessions" | "protected_jobs"> {
		const blockers: Array<"clients" | "sessions" | "protected_jobs"> = [];
		if ([...this.#connections].some(connection => connection !== excluded)) blockers.push("clients");
		if (this.#registry?.hasLiveSessions) blockers.push("sessions");
		if ((this.#registry?.protectedJobCount ?? 0) > 0) blockers.push("protected_jobs");
		return blockers;
	}

	#accept(socket: net.Socket): void {
		if (this.#closed || this.#connections.size >= this.#maxClients) {
			socket.destroy();
			return;
		}
		const connection: Connection = {
			socket,
			buffer: "",
			authenticated: false,
			attachments: new Set(),
			requestIds: new Set(),
			closed: false,
			generation: 0,
		};
		this.#connections.add(connection);
		socket.setEncoding("utf8");
		socket.on("data", chunk => this.#onData(connection, typeof chunk === "string" ? chunk : chunk.toString("utf8")));
		socket.on("error", () => undefined);
		socket.on("end", () => this.#releaseConnection(connection));
		socket.on("close", () => this.#releaseConnection(connection));
	}

	#releaseConnection(connection: Connection): void {
		if (connection.closed) return;
		connection.closed = true;
		connection.generation++;
		for (const key of connection.attachments) {
			const separator = key.indexOf("\0");
			if (separator > 0) this.#registry?.disconnect(key.slice(0, separator), key.slice(separator + 1));
		}
		connection.attachments.clear();
		this.#connections.delete(connection);
	}
	#onData(connection: Connection, chunk: string): void {
		connection.buffer += chunk;
		if (Buffer.byteLength(connection.buffer, "utf8") > DAEMON_MAX_FRAME_BYTES && !connection.buffer.includes("\n")) {
			connection.socket.destroy();
			return;
		}
		for (;;) {
			const newline = connection.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = connection.buffer.slice(0, newline).replace(/\r$/, "");
			connection.buffer = connection.buffer.slice(newline + 1);
			if (!line) continue;
			this.#onLine(connection, line);
			if (connection.socket.destroyed) return;
		}
	}

	#onLine(connection: Connection, line: string): void {
		let frame: DaemonFrame;
		try {
			frame = decodeDaemonFrame(line);
		} catch (error) {
			this.#sendProtocolError(connection, requestIdOf(this.#parseRaw(line)), error);
			connection.socket.destroy();
			return;
		}
		if (!connection.authenticated) {
			if (frame.tag !== "hello") {
				this.#sendError(
					connection,
					requestIdOf(frame),
					"authentication_failed",
					"hello is required before requests",
				);
				connection.socket.destroy();
				return;
			}
			void this.#hello(connection, frame);
			return;
		}
		if (frame.tag !== "request") {
			this.#sendError(connection, requestIdOf(frame), "invalid_request", "request frame required");
			return;
		}
		if (connection.requestIds.has(frame.requestId)) {
			this.#sendError(connection, frame.requestId, "invalid_request", "duplicate requestId");
			return;
		}
		connection.requestIds.add(frame.requestId);
		const generation = connection.generation;
		void this.#dispatch(connection, frame, generation).finally(() => connection.requestIds.delete(frame.requestId));
	}

	async #hello(connection: Connection, hello: DaemonHello): Promise<void> {
		const expectedRoot = await canonicalProjectRoot(this.#configuredProjectRoot);
		const profileMatches = hello.profile === this.profile;
		const rootMatches = hello.projectRoot === expectedRoot;
		const tokenMatches = typeof this.#token === "string" && constantTimeTokenEquals(this.#token, hello.token);
		if (!profileMatches || !rootMatches || !tokenMatches) {
			const reason = !profileMatches
				? "profile mismatch"
				: !rootMatches
					? `project-root mismatch (${hello.projectRoot} != ${expectedRoot})`
					: "token mismatch";
			this.#sendError(
				connection,
				hello.requestId,
				"authentication_failed",
				`daemon authentication failed: ${reason}`,
			);
			connection.socket.destroy();
			return;
		}
		connection.authenticated = true;
		this.#send(connection, {
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "hello_ok",
			requestId: hello.requestId,
			daemonId: this.#daemonId,
			serverVersion: this.#serverVersion,
			protocolVersion: DAEMON_PROTOCOL_MAJOR,
			shard: { profile: this.profile, projectRoot: expectedRoot },
			capabilities: ["snapshot", "events", "server_status"],
		});
	}
	async #dispatch(connection: Connection, request: DaemonRequest, generation: number): Promise<void> {
		if (!this.#connectionActive(connection, generation)) return;
		try {
			const result = await this.#serializeRequest(() => {
				if (!this.#connectionActive(connection, generation)) return Promise.resolve(SKIP_DISPATCH);
				return this.#execute(connection, request.operation, generation);
			});
			if (result === SKIP_DISPATCH || !this.#connectionActive(connection, generation)) return;
			this.#send(connection, {
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "response",
				requestId: request.requestId,
				ok: true,
				result,
			});
		} catch (error) {
			if (this.#connectionActive(connection, generation)) {
				this.#sendError(connection, request.requestId, errorCode(error), unknownErrorMessage(error));
			}
		}
	}

	async #execute(
		connection: Connection,
		operation: DaemonOperation,
		generation: number,
	): Promise<unknown | typeof SKIP_DISPATCH> {
		if (!this.#connectionActive(connection, generation)) return SKIP_DISPATCH;
		const registry = this.registry;
		switch (operation.op) {
			case "ping":
				return { ok: true, daemonId: this.#daemonId };
			case "server_status":
				return this.status();
			case "session_create":
				return registry.create(operation.sessionId, operation.cwd, operation.overrides);
			case "session_list":
				return registry.list();
			case "session_load":
				return registry.load(operation.sessionId);
			case "session_resume":
				return registry.resume(operation.sessionId);
			case "session_close":
				return registry.close(operation.sessionId);
			case "attach": {
				const key = `${operation.sessionId}\0${operation.attachmentId}`;
				const attached = await registry.attach(
					operation.sessionId,
					operation.attachmentId,
					operation.mode,
					frame => this.#sendAttachmentFrame(connection, operation.sessionId, operation.attachmentId, frame),
					operation.lastSeq,
				);
				if (!this.#connectionActive(connection, generation)) {
					registry.disconnect(operation.sessionId, operation.attachmentId);
					return SKIP_DISPATCH;
				}
				connection.attachments.add(key);
				for (const frame of attached.frames)
					this.#sendAttachmentFrame(connection, operation.sessionId, operation.attachmentId, frame);
				return {
					sessionId: attached.sessionId,
					attachmentId: attached.attachmentId,
					mode: attached.mode,
					barrierSeq: attached.barrierSeq,
				};
			}
			case "detach": {
				this.#requireAttachmentOwnership(connection, operation.sessionId, operation.attachmentId);
				const detached = registry.detach(operation.sessionId, operation.attachmentId);
				connection.attachments.delete(`${operation.sessionId}\0${operation.attachmentId}`);
				return detached;
			}
			case "session_command":
				this.#requireAttachmentOwnership(connection, operation.sessionId, operation.attachmentId);
				return registry.command(operation.sessionId, operation.attachmentId, operation.command);
			case "snapshot_ack":
				this.#requireAttachmentOwnership(connection, operation.sessionId, operation.attachmentId);
				return registry.snapshotAck(operation.sessionId, operation.attachmentId, operation.seq);
			case "shutdown": {
				const blockers = this.#shutdownBlockers(connection);
				if (blockers.length > 0) return { shutdown: false, blockers };
				setTimeout(() => {
					void this.shutdown(true);
				}, 0);
				return { shutdown: true, blockers: [] };
			}
		}
	}

	#connectionActive(connection: Connection, generation: number): boolean {
		return (
			!connection.closed &&
			connection.generation === generation &&
			this.#connections.has(connection) &&
			!connection.socket.destroyed
		);
	}

	#requireAttachmentOwnership(connection: Connection, sessionId: string, attachmentId: string): void {
		if (!connection.attachments.has(`${sessionId}\0${attachmentId}`))
			throw new RegistryError("not_found", `attachment ${attachmentId} is not owned by this connection`);
	}

	async #serializeRequest<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.#requestQueue;
		const deferred = Promise.withResolvers<T>();
		this.#requestQueue = previous.then(async () => {
			try {
				deferred.resolve(await task());
			} catch (error) {
				deferred.reject(error);
			}
		});
		return deferred.promise;
	}

	#sendAttachmentFrame(connection: Connection, sessionId: string, attachmentId: string, frame: unknown): void {
		if (connection.socket.destroyed) return;
		const type = frameType(frame);
		if (!type) return;
		if (type === "event") {
			const seq = frameSeq(frame);
			if (
				seq === undefined ||
				typeof frame !== "object" ||
				frame === null ||
				Array.isArray(frame) ||
				!("event" in frame)
			)
				return;
			this.#send(connection, { v: DAEMON_PROTOCOL_MAJOR, tag: "event", sessionId, seq, event: frame.event });
			return;
		}
		if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
		const barrierSeq = "barrierSeq" in frame && typeof frame.barrierSeq === "number" ? frame.barrierSeq : undefined;
		if (type !== "snapshot_restart" && barrierSeq === undefined) return;
		if (type === "snapshot_begin") {
			this.#send(connection, {
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "snapshot_begin",
				barrierSeq: barrierSeq ?? 0,
				sessionId,
				attachmentId,
			});
		} else if (type === "snapshot_chunk" && "index" in frame && typeof frame.index === "number" && "chunk" in frame) {
			this.#send(connection, {
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "snapshot_chunk",
				barrierSeq: barrierSeq ?? 0,
				sessionId,
				attachmentId,
				index: frame.index,
				chunk: frame.chunk,
			});
		} else if (type === "snapshot_end" && "nextSeq" in frame && typeof frame.nextSeq === "number") {
			this.#send(connection, {
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "snapshot_end",
				barrierSeq: barrierSeq ?? 0,
				sessionId,
				attachmentId,
				nextSeq: frame.nextSeq,
			});
		} else if (
			type === "snapshot_restart" &&
			"reason" in frame &&
			(frame.reason === "overflow" || frame.reason === "gap") &&
			"previousBarrierSeq" in frame &&
			typeof frame.previousBarrierSeq === "number"
		) {
			this.#send(connection, {
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "snapshot_restart",
				sessionId,
				attachmentId,
				previousBarrierSeq: frame.previousBarrierSeq,
				reason: frame.reason,
			});
		}
	}

	#send(connection: Connection, frame: DaemonFrame): void {
		if (!connection.socket.destroyed) connection.socket.write(encodeDaemonFrame(frame));
	}

	#sendError(connection: Connection, requestId: string | undefined, code: DaemonErrorCode, message: string): void {
		if (!requestId) return;
		this.#send(connection, {
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "response",
			requestId,
			ok: false,
			error: { code, message },
		});
	}

	#sendProtocolError(connection: Connection, requestId: string | undefined, error: unknown): void {
		this.#sendError(connection, requestId, errorCode(error), unknownErrorMessage(error));
	}

	#parseRaw(line: string): unknown {
		try {
			return JSON.parse(line) as unknown;
		} catch {
			return undefined;
		}
	}
}

export type StartDaemonServerOptions = Omit<DaemonServerOptions, "profile" | "projectRoot"> & {
	profile?: string;
	projectRoot?: string;
};

/** Hidden-worker entrypoint used by cli.ts. */
export async function startDaemonServerFromEnvironment(options: StartDaemonServerOptions = {}): Promise<DaemonServer> {
	const profile =
		options.profile ??
		process.env.OMP_DAEMON_PROFILE ??
		process.env.OMP_PROFILE ??
		process.env.PI_PROFILE ??
		"default";
	const projectRoot =
		options.projectRoot ?? process.env.OMP_DAEMON_PROJECT_DIR ?? process.env.OMP_DAEMON_PROJECT_ROOT ?? process.cwd();
	const runtimeDir = options.runtimeDir ?? process.env.OMP_DAEMON_RUNTIME_DIR;
	await Settings.init({ cwd: projectRoot });
	const server = new DaemonServer({ ...options, profile, projectRoot, runtimeDir });
	await server.run();
	return server;
}

/** Start one shard server when the caller owns the process lifecycle. */
export async function ensureDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
	const server = new DaemonServer(options);
	await server.run();
	return server;
}
