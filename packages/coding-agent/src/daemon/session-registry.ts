import { logger } from "@oh-my-pi/pi-utils";
import { AttachmentEventStream, type EventRecord, OrderedEventLog } from "./event-log";
import { canonicalProjectRoot, isDaemonPathInScope } from "./paths";
import type {
	DaemonSessionCreateOverrides,
	DaemonSessionRuntime,
	DaemonSessionRuntimeFactory,
} from "./session-runtime";

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
	projectRoot: string;
	runtimeFactory: DaemonSessionRuntimeFactory;
	id?: () => string;
	sessionDir?: string;
	/** Resolve persisted session files for `session_load`/`session_resume`. */
	listSessions?: (cwd: string) => Promise<ReadonlyArray<{ id: string; path: string; cwd: string }>>;
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
};

function closesHostedSession(event: unknown): boolean {
	if (typeof event !== "object" || event === null) return false;
	const record = event as Record<string, unknown>;
	return record.type === "terminal_closed" && (record.reason === "exit" || record.reason === "error");
}

/** Owns every daemon AgentSession and serializes all mutations to it. */
export class DaemonSessionRegistry {
	readonly #projectRoot: string;
	readonly #runtimeFactory: DaemonSessionRuntimeFactory;
	readonly #id: () => string;
	readonly #sessionDir: string | undefined;
	readonly #listSessions: DaemonSessionRegistryOptions["listSessions"];
	readonly #sessions = new Map<string, SessionRecord>();
	readonly #closing = new Set<Promise<void>>();

	constructor(options: DaemonSessionRegistryOptions) {
		this.#projectRoot = options.projectRoot;
		this.#runtimeFactory = options.runtimeFactory;
		this.#id = options.id ?? (() => crypto.randomUUID());
		this.#sessionDir = options.sessionDir;
		this.#listSessions = options.listSessions;
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
		sessionId?: string,
		cwd = this.#projectRoot,
		overrides?: DaemonSessionCreateOverrides,
	): Promise<DaemonSessionSummary> {
		const resolvedCwd = await this.#assertScope(cwd);
		const id = sessionId ?? this.#id();
		if (this.#sessions.has(id)) throw new RegistryError("session_busy", `session ${id} already exists`);
		const runtime = await this.#runtimeFactory({
			cwd: resolvedCwd,
			sessionId: id,
			sessionDir: this.#sessionDir,
			overrides,
		});
		return this.#install(id, runtime);
	}

	async load(sessionId: string): Promise<DaemonSessionSummary> {
		const existing = this.#sessions.get(sessionId);
		if (existing) return this.#summary(sessionId, existing);
		const sessions = await this.#listSessions?.(this.#projectRoot);
		const info = sessions?.find(item => item.id === sessionId);
		if (!info) throw new RegistryError("not_found", `session ${sessionId} was not found`);
		const cwd = await this.#assertScope(info.cwd || this.#projectRoot);
		const runtime = await this.#runtimeFactory({
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
		await this.#serialize(record, async () => {
			if (record.closed) return;
			record.closed = true;
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
		});
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
		const stream = new AttachmentEventStream<unknown, unknown>(record.log, {
			chunkSize: 64,
			maxBufferedEvents: 2048,
			snapshot: () => record.runtime.snapshot(),
			chunks: snapshot => [snapshot],
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
		return this.#serialize(record, () => record.runtime.command(command, attachmentId));
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
		for (const sessionId of [...this.#sessions.keys()]) await this.close(sessionId);
		await Promise.allSettled([...this.#closing]);
	}

	#install(sessionId: string, runtime: DaemonSessionRuntime): DaemonSessionSummary {
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
			const published = record.log.append(event);
			for (const attachment of record.attachments.values()) {
				if (attachment.attaching) {
					attachment.pending.push(published);
					continue;
				}
				const frames = attachment.stream.publish(published);
				for (const frame of frames) void Promise.resolve(attachment.sink(frame)).catch(() => undefined);
			}
			if (closesHostedSession(event)) void this.close(sessionId).catch(() => undefined);
		});
		this.#sessions.set(sessionId, record);
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

	async #assertScope(cwd: string): Promise<string> {
		const canonical = await canonicalProjectRoot(cwd);
		if (!isDaemonPathInScope(this.#projectRoot, canonical))
			throw new RegistryError("session_scope_error", `session cwd is outside daemon project root: ${cwd}`);
		return canonical;
	}
}

export class RegistryError extends Error {
	readonly code: "not_found" | "session_busy" | "session_scope_error" | "internal";

	constructor(code: "not_found" | "session_busy" | "session_scope_error" | "internal", message: string) {
		super(message);
		this.name = "RegistryError";
		this.code = code;
	}
}
