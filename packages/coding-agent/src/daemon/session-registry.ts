import { logger } from "@oh-my-pi/pi-utils";
import { recordDaemonSessionAlias } from "../session/session-listing";
import { AttachmentEventStream, type EventRecord, OrderedEventLog } from "./event-log";
import { canonicalProjectRoot } from "./paths";
import { DAEMON_MAX_FRAME_BYTES, encodeDaemonSnapshotChunks, splitDaemonTerminalOutput } from "./protocol";
import type {
	DaemonSessionCreateOverrides,
	DaemonSessionRuntime,
	DaemonSessionRuntimeFactory,
} from "./session-runtime";

export const DEFAULT_DETACHED_SESSION_TTL_MS = 420_000;
export type DaemonAttachmentMode = "interactive" | "observe";

export type DaemonAttachment = {
	readonly sessionId: string;
	readonly attachmentId: string;
	readonly mode: DaemonAttachmentMode;
	readonly stream: AttachmentEventStream<unknown, unknown>;
};

export type DaemonSessionSummary = {
	sessionId: string;
	cwd: string;
	attachmentCount: number;
	interactiveAttached: boolean;
	isStreaming: boolean;
};

export type DaemonSessionRegistryOptions = {
	runtimeFactory: DaemonSessionRuntimeFactory;
	id?: () => string;
	sessionDir?: string;
	/** Resolve persisted session files for `session_load`/`session_resume`. */
	listSessions?: () => Promise<ReadonlyArray<{ id: string; path: string; cwd: string }>>;
	detachedSessionTtlMs?: number;
};

type AttachmentSink = (frame: unknown) => void | Promise<void>;

type AttachmentRecord = {
	id: string;
	mode: DaemonAttachmentMode;
	stream: AttachmentEventStream<unknown, unknown>;
	sink: AttachmentSink;
	attaching: boolean;
	pending: EventRecord<unknown>[];
};

type SessionRecord = {
	runtime: DaemonSessionRuntime;
	log: OrderedEventLog<unknown>;
	attachments: Map<string, AttachmentRecord>;
	interactiveAttachment?: string;
	unsubscribe: () => void;
	queue: Promise<void>;
	closed: boolean;
	parkTimer?: NodeJS.Timeout;
};

function closesHostedSession(event: unknown): boolean {
	if (typeof event !== "object" || event === null) return false;
	const record = event as Record<string, unknown>;
	return record.type === "terminal_closed" && (record.reason === "exit" || record.reason === "error");
}

/** Frame-envelope headroom below DAEMON_MAX_FRAME_BYTES for tag/seq/ids. */
const MAX_DAEMON_EVENT_BYTES = DAEMON_MAX_FRAME_BYTES - 8192;

/**
 * Bound one event to what a wire frame can carry. An oversized event is
 * POISON: encoding throws at send time, synchronously, through the session's
 * subscribe listener — and replay hits the same encode failure forever, so
 * the attachment stream wedges and the client freezes (observed with a huge
 * tool payload in a 120MB session). Replace it with a compact marker so seq
 * continuity and the live stream survive; the client loses one event's body,
 * not the session.
 */
function boundDaemonEvent(event: unknown): unknown {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(event);
	} catch {
		// Circular payloads would also fail frame encoding.
		return { type: "daemon_event_truncated", reason: "unserializable" };
	}
	// JSON.stringify(undefined / toJSON→undefined) yields undefined: encoding
	// such an event would drop the frame's event key and emit a malformed frame.
	if (serialized === undefined) return { type: "daemon_event_truncated", reason: "unserializable" };
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes <= MAX_DAEMON_EVENT_BYTES) return event;
	const type =
		typeof event === "object" && event !== null && "type" in event ? String(event.type).slice(0, 128) : "unknown";
	logger.warn("Dropping oversized daemon session event", { type, bytes });
	return { type: "daemon_event_truncated", reason: "oversized", originalType: type, bytes };
}

function splitDaemonEvent(event: unknown): readonly unknown[] {
	if (
		typeof event !== "object" ||
		event === null ||
		Array.isArray(event) ||
		!("type" in event) ||
		event.type !== "terminal_output" ||
		!("data" in event) ||
		typeof event.data !== "string"
	)
		return [boundDaemonEvent(event)];
	// Terminal output is bounded by construction: our own bridge emits exactly
	// {type, data} and the splitter caps data at 128K code units per chunk —
	// re-measuring every chunk would tax the hottest streaming path for a
	// shape this codebase cannot produce.
	return splitDaemonTerminalOutput(event.data).map(data => ({ ...event, data }));
}

/** Owns every daemon AgentSession and serializes all mutations to it. */
export class DaemonSessionRegistry {
	readonly #runtimeFactory: DaemonSessionRuntimeFactory;
	readonly #id: () => string;
	readonly #sessionDir: string | undefined;
	readonly #listSessions: DaemonSessionRegistryOptions["listSessions"];
	readonly #detachedSessionTtlMs: number;
	readonly #sessions = new Map<string, SessionRecord>();
	readonly #closing = new Set<Promise<void>>();
	/** In-flight runtime factory builds (create/load); dispose drains these. */
	readonly #building = new Set<Promise<DaemonSessionRuntime>>();
	/** Set at dispose(): late factory completions must not install. */
	#disposed = false;

	constructor(options: DaemonSessionRegistryOptions) {
		this.#runtimeFactory = options.runtimeFactory;
		this.#id = options.id ?? (() => crypto.randomUUID());
		this.#sessionDir = options.sessionDir;
		this.#listSessions = options.listSessions;
		this.#detachedSessionTtlMs = Number.isFinite(options.detachedSessionTtlMs)
			? Math.max(0, options.detachedSessionTtlMs ?? DEFAULT_DETACHED_SESSION_TTL_MS)
			: DEFAULT_DETACHED_SESSION_TTL_MS;
	}

	get sessionCount(): number {
		return this.#sessions.size;
	}

	get attachmentCount(): number {
		let count = 0;
		for (const record of this.#sessions.values()) count += record.attachments.size;
		return count;
	}

	get protectedJobCount(): number {
		let count = 0;
		for (const record of this.#sessions.values()) count += record.runtime.protectedJobCount?.() ?? 0;
		return count;
	}

	get hasLiveSessions(): boolean {
		return [...this.#sessions.values()].some(record => !record.closed);
	}

	get hasInteractiveAttachments(): boolean {
		return [...this.#sessions.values()].some(record => record.interactiveAttachment !== undefined);
	}

	status(): { sessionCount: number; attachmentCount: number; protectedJobCount: number } {
		return {
			sessionCount: this.sessionCount,
			attachmentCount: this.attachmentCount,
			protectedJobCount: this.protectedJobCount,
		};
	}

	async create(
		sessionId: string | undefined,
		cwd: string,
		overrides?: DaemonSessionCreateOverrides,
	): Promise<DaemonSessionSummary> {
		const resolvedCwd = await canonicalProjectRoot(cwd);
		if (sessionId) {
			if (this.#sessions.has(sessionId))
				throw new RegistryError("session_busy", `session ${sessionId} already exists`);
			// A caller naming a session wants THAT session back (recovery after a
			// daemon replacement): rehydrate its transcript when it exists on
			// disk instead of silently starting a blank session under its id.
			const sessions = await this.#listSessions?.();
			const info = sessions?.find(item => item.id === sessionId);
			if (info) {
				const runtime = await this.#buildRuntime({
					cwd: await canonicalProjectRoot(info.cwd),
					sessionId,
					sessionFile: info.path,
					sessionDir: this.#sessionDir,
					overrides,
				});
				return this.#install(sessionId, runtime);
			}
		}
		const runtime = await this.#buildRuntime({
			cwd: resolvedCwd,
			sessionId,
			sessionDir: this.#sessionDir,
			overrides,
		});
		// ONE id everywhere: the registry keys hosted sessions by the underlying
		// session's own id (the one in the transcript filename), never a minted
		// handle — `--resume <id printed anywhere>` must behave exactly like
		// `/resume <id>`. The random fallback only covers sessionless runtimes.
		const id = runtime.session.sessionId ?? sessionId ?? this.#id();
		if (this.#sessions.has(id)) {
			await runtime.dispose().catch(() => undefined);
			throw new RegistryError("session_busy", `session ${id} already exists`);
		}
		return this.#install(id, runtime);
	}

	async load(sessionId: string): Promise<DaemonSessionSummary> {
		const existing = this.#sessions.get(sessionId);
		if (existing) return this.#summary(sessionId, existing);
		const sessions = await this.#listSessions?.();
		const info = sessions?.find(item => item.id === sessionId);
		if (!info) throw new RegistryError("not_found", `session ${sessionId} was not found`);
		const cwd = await canonicalProjectRoot(info.cwd);
		const runtime = await this.#buildRuntime({
			cwd,
			sessionId,
			sessionFile: info.path,
			sessionDir: this.#sessionDir,
		});
		return this.#install(sessionId, runtime);
	}

	async resume(sessionId: string): Promise<DaemonSessionSummary> {
		return this.load(sessionId);
	}

	list(): DaemonSessionSummary[] {
		return [...this.#sessions].map(([id, record]) => this.#summary(id, record));
	}

	async close(sessionId: string): Promise<{ closed: true }> {
		const record = this.#require(sessionId);
		await this.#serialize(record, () => this.#closeRecord(sessionId, record));
		return { closed: true };
	}

	async attach(
		sessionId: string,
		attachmentId: string,
		mode: DaemonAttachmentMode,
		sink: AttachmentSink,
		lastSeq?: number,
	): Promise<{
		sessionId: string;
		attachmentId: string;
		mode: DaemonAttachmentMode;
		frames: unknown[];
		barrierSeq: number;
	}> {
		const record = this.#require(sessionId);
		if (record.attachments.has(attachmentId))
			throw new RegistryError("session_busy", `attachment ${attachmentId} already exists`);
		if (mode === "interactive" && record.interactiveAttachment && record.interactiveAttachment !== attachmentId)
			throw new RegistryError("session_busy", `session ${sessionId} already has an interactive attachment`);
		this.#cancelParking(record);
		const stream = new AttachmentEventStream<unknown, unknown>(record.log, {
			chunkSize: 64,
			maxBufferedEvents: 2048,
			snapshot: () => record.runtime.snapshot(),
			chunks: encodeDaemonSnapshotChunks,
			sink: frame => sink(frame),
			attachmentId,
		});
		const attachment: AttachmentRecord = { id: attachmentId, mode, stream, sink, attaching: true, pending: [] };
		record.attachments.set(attachmentId, attachment);
		if (mode === "interactive") record.interactiveAttachment = attachmentId;
		try {
			const frames: unknown[] = [...stream.attach(lastSeq)];
			for (;;) {
				const next = stream.next();
				if (next.length === 0) break;
				frames.push(...next);
			}
			attachment.attaching = false;
			for (const pending of attachment.pending.splice(0)) {
				const pendingFrames = attachment.stream.publish(pending);
				for (const frame of pendingFrames) void Promise.resolve(attachment.sink(frame)).catch(() => undefined);
			}
			return {
				sessionId,
				attachmentId,
				mode,
				frames,
				barrierSeq: stream.barrierSeq ?? record.log.latestSeq,
			};
		} catch (error) {
			this.#detachRecord(record, attachmentId);
			throw error;
		}
	}

	detach(sessionId: string, attachmentId: string): { detached: true } {
		const record = this.#require(sessionId);
		const attachment = record.attachments.get(attachmentId);
		if (!attachment) throw new RegistryError("not_found", `attachment ${attachmentId} was not found`);
		this.#detachRecord(record, attachmentId);
		return { detached: true };
	}

	async command(sessionId: string, attachmentId: string, command: unknown): Promise<unknown> {
		const record = this.#require(sessionId);
		const attachment = record.attachments.get(attachmentId);
		if (!attachment) throw new RegistryError("not_found", `attachment ${attachmentId} was not found`);
		if (attachment.mode !== "interactive")
			throw new RegistryError("session_busy", "observe attachment cannot issue commands");
		return this.#serialize(record, () => {
			// Re-check INSIDE the record queue: a close that was queued ahead of
			// this command has already disposed the runtime by the time this
			// task runs, and a disposed runtime must never receive commands.
			if (record.closed) throw new RegistryError("not_found", `session ${sessionId} was closed`);
			return record.runtime.command(command, attachmentId);
		});
	}

	snapshotAck(sessionId: string, attachmentId: string, seq: number): { acknowledged: number } {
		const record = this.#require(sessionId);
		const attachment = record.attachments.get(attachmentId);
		if (!attachment) throw new RegistryError("not_found", `attachment ${attachmentId} was not found`);
		record.log.acknowledge(attachmentId, seq);
		attachment.stream.acknowledge(seq);
		return { acknowledged: seq };
	}

	/** Disconnect only releases the attachment; active work remains owned by the runtime. */
	disconnect(sessionId: string, attachmentId: string): void {
		const record = this.#sessions.get(sessionId);
		if (!record) return;
		if (record.attachments.has(attachmentId)) this.#detachRecord(record, attachmentId);
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		for (const sessionId of [...this.#sessions.keys()]) await this.close(sessionId);
		// Drain to quiescence: an in-flight runtime factory settles into a
		// #install rejection whose runtime disposal lands in #closing — loop
		// until nothing new appears so no runtime outlives the registry.
		while (this.#building.size > 0 || this.#closing.size > 0) {
			await Promise.allSettled([...this.#building, ...this.#closing]);
		}
	}

	/** Run the runtime factory tracked, so dispose() can drain late builds. */
	async #buildRuntime(args: Parameters<DaemonSessionRuntimeFactory>[0]): Promise<DaemonSessionRuntime> {
		if (this.#disposed) throw new RegistryError("internal", "registry is shutting down");
		const building = Promise.resolve(this.#runtimeFactory(args));
		this.#building.add(building);
		try {
			return await building;
		} finally {
			this.#building.delete(building);
		}
	}

	/** Dispose a runtime rejected by {@link #install}; awaitable via #closing. */
	#disposeRejected(runtime: DaemonSessionRuntime): void {
		const settling = Promise.resolve(runtime.dispose()).catch(() => undefined);
		this.#closing.add(settling);
		void settling.finally(() => this.#closing.delete(settling));
	}

	#install(sessionId: string, runtime: DaemonSessionRuntime): DaemonSessionSummary {
		// Final atomic guard: callers' existence checks run BEFORE awaited
		// factory work, so two racing creates/loads resolving to the same id
		// both reach here — and a factory that outlives the shutdown drain
		// budget must not install into a disposed registry (that would leak a
		// live runtime with no owner). The checks + set below are synchronous.
		if (this.#disposed) {
			this.#disposeRejected(runtime);
			throw new RegistryError("internal", "registry is shutting down");
		}
		if (this.#sessions.has(sessionId)) {
			this.#disposeRejected(runtime);
			throw new RegistryError("session_busy", `session ${sessionId} already exists`);
		}
		const log = new OrderedEventLog<unknown>();
		const record: SessionRecord = {
			runtime,
			log,
			attachments: new Map(),
			unsubscribe: () => undefined,
			queue: Promise.resolve(),
			closed: false,
		};
		record.unsubscribe = runtime.subscribe(event => {
			for (const boundedEvent of splitDaemonEvent(event)) {
				const published = record.log.append(boundedEvent);
				for (const attachment of record.attachments.values()) {
					if (attachment.attaching) {
						attachment.pending.push(published);
						continue;
					}
					const frames = attachment.stream.publish(published);
					for (const frame of frames) void Promise.resolve(attachment.sink(frame)).catch(() => undefined);
				}
				if (closesHostedSession(boundedEvent)) void this.close(sessionId).catch(() => undefined);
			}
			this.#scheduleParking(sessionId, record);
		});
		this.#sessions.set(sessionId, record);
		// Ledger the registry handle → transcript mapping: anything that shows
		// this handle to the user must stay resumable after the daemon exits.
		void recordDaemonSessionAlias(sessionId, runtime.session.sessionFile ?? "");
		this.#scheduleParking(sessionId, record);
		return this.#summary(sessionId, record);
	}

	#summary(sessionId: string, record: SessionRecord): DaemonSessionSummary {
		return {
			sessionId,
			cwd: record.runtime.cwd,
			attachmentCount: record.attachments.size,
			interactiveAttached: record.interactiveAttachment !== undefined,
			isStreaming: record.runtime.session.isStreaming === true,
		};
	}

	#require(sessionId: string): SessionRecord {
		const record = this.#sessions.get(sessionId);
		if (!record || record.closed) throw new RegistryError("not_found", `session ${sessionId} was not found`);
		return record;
	}

	#detachRecord(record: SessionRecord, attachmentId: string): void {
		const attachment = record.attachments.get(attachmentId);
		if (!attachment) return;
		if (attachment.mode === "interactive") {
			void record.runtime.command({ type: "terminal_detach" }, attachmentId).catch(() => undefined);
		}
		record.attachments.delete(attachmentId);
		if (record.interactiveAttachment === attachmentId) record.interactiveAttachment = undefined;
		record.log.unregisterAttachment(attachmentId);
		this.#scheduleParking(record.runtime.sessionId, record);
	}

	#cancelParking(record: SessionRecord): void {
		clearTimeout(record.parkTimer);
		record.parkTimer = undefined;
	}

	#canPark(record: SessionRecord): boolean {
		return (
			!record.closed &&
			record.attachments.size === 0 &&
			record.runtime.session.isStreaming !== true &&
			(record.runtime.protectedJobCount?.() ?? 0) === 0
		);
	}

	#scheduleParking(sessionId: string, record: SessionRecord): void {
		this.#cancelParking(record);
		if (!this.#canPark(record)) return;
		record.parkTimer = setTimeout(() => {
			record.parkTimer = undefined;
			void this.#serialize(record, async () => {
				if (this.#sessions.get(sessionId) !== record || record.closed) return;
				if (!this.#canPark(record)) {
					this.#scheduleParking(sessionId, record);
					return;
				}
				await this.#closeRecord(sessionId, record);
			}).catch(error => {
				logger.warn("Failed to park detached daemon session", { sessionId, error });
			});
		}, this.#detachedSessionTtlMs);
	}

	async #closeRecord(sessionId: string, record: SessionRecord): Promise<void> {
		if (record.closed) return;
		record.closed = true;
		// The transcript may have materialized only after install; refresh the
		// handle → file alias with the final path before the runtime goes away.
		void recordDaemonSessionAlias(sessionId, record.runtime.session.sessionFile ?? "");
		this.#cancelParking(record);
		logger.debug("Daemon session close started", { sessionId, attachmentCount: record.attachments.size });
		record.unsubscribe();
		for (const attachment of [...record.attachments.values()]) this.#detachRecord(record, attachment.id);
		record.attachments.clear();
		record.interactiveAttachment = undefined;
		this.#sessions.delete(sessionId);
		logger.debug("Daemon session removed from live registry", { sessionId });
		const disposal = record.runtime.dispose();
		this.#closing.add(disposal);
		try {
			await disposal;
		} finally {
			this.#closing.delete(disposal);
			logger.debug("Daemon session runtime cleanup settled", { sessionId });
		}
	}

	async #serialize<T>(record: SessionRecord, task: () => Promise<T>): Promise<T> {
		const previous = record.queue;
		const deferred = Promise.withResolvers<T>();
		record.queue = previous.then(async () => {
			try {
				deferred.resolve(await task());
			} catch (error) {
				deferred.reject(error);
			}
		});
		return deferred.promise;
	}
}

export class RegistryError extends Error {
	readonly code: "not_found" | "session_busy" | "internal";

	constructor(code: "not_found" | "session_busy" | "internal", message: string) {
		super(message);
		this.name = "RegistryError";
		this.code = code;
	}
}
