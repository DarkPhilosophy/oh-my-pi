import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import type { DaemonClient } from "../src/daemon/client";
import type { DaemonEvent, DaemonSnapshotFrame } from "../src/daemon/protocol";
import type { DaemonConnectionSnapshot } from "../src/daemon/status";
import type { AgentSession } from "../src/session/agent-session";
import type { SessionEntry } from "../src/session/session-entries";
import { LocalSessionHandle, RemoteSessionHandle } from "../src/session/session-handle";

const model = {
	provider: "test",
	id: "model",
	contextWindow: 1000,
	maxTokens: 100,
	reasoning: false,
	input: ["text"],
	temperature: 0,
} as unknown as Model;

class Transport {
	readonly requests: Array<{
		operation: string;
		payload: Record<string, unknown>;
	}> = [];
	readonly snapshotListeners = new Set<(snapshot: DaemonConnectionSnapshot) => void>();
	readonly frameListeners = new Set<(frame: DaemonSnapshotFrame) => void>();
	readonly eventListeners = new Set<(event: DaemonEvent) => void>();
	attachFrames: unknown[] = [];
	attachFailures = 0;
	loadNotFound = false;
	state: DaemonConnectionSnapshot = {
		state: "connected",
		shard: { profile: "test" },
		serverVersion: "1",
		protocolVersion: 1,
		sessionCount: 1,
		attachmentCount: 1,
		protectedJobCount: 0,
		uptimeMs: 1,
	};
	async connect(): Promise<void> {}
	onSnapshot(listener: (snapshot: DaemonConnectionSnapshot) => void): () => void {
		this.snapshotListeners.add(listener);
		return () => this.snapshotListeners.delete(listener);
	}
	onSnapshotFrame(listener: (frame: DaemonSnapshotFrame) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}
	onEvent(listener: (event: DaemonEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}
	get snapshot(): DaemonConnectionSnapshot {
		return this.state;
	}
	async request(operation: string, payload: Record<string, unknown>): Promise<unknown> {
		this.requests.push({ operation, payload });
		if (operation === "session_load" && this.loadNotFound) {
			this.loadNotFound = false;
			throw new Error("not_found: session s was not found");
		}
		if (operation === "attach" && this.attachFailures > 0) {
			this.attachFailures--;
			throw new Error("unavailable: replacement runtime is still loading");
		}
		if (operation === "attach") return { frames: this.attachFrames };
		if (operation === "session_command") {
			if (!payload.command || typeof payload.command !== "object" || !("type" in payload.command)) return undefined;
			if (payload.command.type === "prompt") return { agentInvoked: true };
			if (payload.command.type === "cycle_model") return { model, thinkingLevel: "medium", isScoped: false };
			if (payload.command.type === "get_available_commands") {
				return {
					commands: [
						{
							name: "plugin-status",
							description: "Plugin status",
							source: "extension",
						},
					],
				};
			}
			if (payload.command.type === "get_state") {
				return {
					...state,
					cwd: "/tmp/project",
					availableToolNames: ["read", "lsp"],
				};
			}
		}
		return undefined;
	}
	emitFrame(frame: DaemonSnapshotFrame): void {
		for (const listener of this.frameListeners) listener(frame);
	}
	emitEvent(event: DaemonEvent): void {
		for (const listener of this.eventListeners) listener(event);
	}
	emitSnapshot(snapshot: DaemonConnectionSnapshot): void {
		this.state = snapshot;
		for (const listener of this.snapshotListeners) listener(snapshot);
	}
	disconnect(): void {
		this.state = {
			state: "unavailable",
			shard: { profile: "test" },
		};
		for (const listener of this.snapshotListeners) listener(this.state);
	}
}

function remote(transport: Transport): RemoteSessionHandle {
	return new RemoteSessionHandle(transport as unknown as DaemonClient, "s", {
		attachmentId: "a",
	});
}

function snapshotFrame(
	tag: "snapshot_begin" | "snapshot_chunk" | "snapshot_end" | "snapshot_restart",
	fields: Record<string, unknown>,
): DaemonSnapshotFrame {
	return {
		v: 1,
		tag,
		sessionId: "s",
		attachmentId: "a",
		...fields,
	} as unknown as DaemonSnapshotFrame;
}

const state = {
	sessionId: "s",
	thinkingLevel: "medium",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	interruptMode: "immediate",
	autoCompactionEnabled: true,
	messageCount: 2,
	queuedMessageCount: 0,
	todoPhases: [],
} as const;

describe("RemoteSessionHandle", () => {
	test("recovers a live sequence gap without publishing later output twice", async () => {
		const transport = new Transport();
		const handle = remote(transport);
		await handle.whenReady();
		const recovered = Promise.withResolvers<void>();
		const received: string[] = [];
		handle.subscribe(event => {
			if (event.type !== "terminal_output") return;
			received.push(event.data);
			if (event.data === "third") recovered.resolve();
		});
		try {
			transport.emitEvent({
				v: 1,
				tag: "event",
				sessionId: "s",
				seq: 1,
				event: { type: "terminal_output", data: "first" },
			});
			transport.attachFrames = [
				{ type: "event", seq: 2, event: { type: "terminal_output", data: "second" } },
				{ type: "event", seq: 3, event: { type: "terminal_output", data: "third" } },
			];
			transport.emitEvent({
				v: 1,
				tag: "event",
				sessionId: "s",
				seq: 3,
				event: { type: "terminal_output", data: "third" },
			});
			await recovered.promise;
			transport.emitEvent({
				v: 1,
				tag: "event",
				sessionId: "s",
				seq: 3,
				event: { type: "terminal_output", data: "third" },
			});
			expect(received).toEqual(["first", "second", "third"]);
		} finally {
			await handle.dispose();
		}
	});
	test("coalesces burst acknowledgements without delaying ordered event delivery", async () => {
		const gate = Promise.withResolvers<void>();
		const settled = Promise.withResolvers<void>();
		const acknowledgements: number[] = [];
		let inFlight = 0;
		let peakInFlight = 0;
		class DelayedAcknowledgements extends Transport {
			override async request(operation: string, payload: Record<string, unknown>): Promise<unknown> {
				if (operation !== "snapshot_ack") return super.request(operation, payload);
				const seq = payload.seq as number;
				acknowledgements.push(seq);
				peakInFlight = Math.max(peakInFlight, ++inFlight);
				try {
					await gate.promise;
					return undefined;
				} finally {
					inFlight--;
					if (seq === 2000) settled.resolve();
				}
			}
		}
		const transport = new DelayedAcknowledgements();
		const handle = remote(transport);
		await handle.whenReady();
		const received: string[] = [];
		handle.subscribe(event => {
			if (event.type === "terminal_output") received.push(event.data);
		});
		try {
			for (let seq = 1; seq <= 2000; seq++) {
				transport.emitEvent({
					v: 1,
					tag: "event",
					sessionId: "s",
					seq,
					event: { type: "terminal_output", data: String(seq) },
				});
			}
			expect(received).toEqual(Array.from({ length: 2000 }, (_, i) => String(i + 1)));
			expect(peakInFlight).toBe(1);
			expect(acknowledgements).toEqual([1]);
			gate.resolve();
			await settled.promise;
			expect(acknowledgements).toEqual([1, 2000]);
		} finally {
			gate.resolve();
			await handle.dispose();
		}
	});
	test("replaces cached state from an ordered snapshot and ignores stale events", async () => {
		const transport = new Transport();
		const handle = remote(transport);
		await Promise.resolve();
		transport.emitFrame(snapshotFrame("snapshot_begin", { barrierSeq: 3 }));
		transport.emitFrame(
			snapshotFrame("snapshot_chunk", {
				barrierSeq: 3,
				index: 0,
				chunk: state,
			}),
		);
		transport.emitFrame(snapshotFrame("snapshot_end", { barrierSeq: 3, nextSeq: 4 }));
		expect(handle.state.messageCount).toBe(2);
		transport.emitEvent({
			v: 1,
			tag: "event",
			sessionId: "s",
			seq: 3,
			event: { type: "message_end" },
		});
		expect(handle.state.messageCount).toBe(2);
		transport.emitEvent({
			v: 1,
			tag: "event",
			sessionId: "s",
			seq: 4,
			event: { type: "agent_start" },
		});
		expect(handle.state.isStreaming).toBe(true);
	});
	test("preserves backward model cycling through the RPC command", async () => {
		const transport = new Transport();
		const handle = remote(transport);
		await handle.whenReady();
		await expect(handle.cycleModel("backward")).resolves.toEqual(model);
		const last = transport.requests.at(-1);
		expect(last?.payload.command).toMatchObject({
			type: "cycle_model",
			direction: "backward",
		});
	});
	test("projects daemon command metadata and refreshes runtime state", async () => {
		const transport = new Transport();
		const handle = remote(transport);
		await handle.whenReady();
		const commands = await handle.getAvailableCommands();
		expect(commands).toContainEqual({
			name: "plugin-status",
			description: "Plugin status",
			source: "extension",
		});
		expect(commands.some(command => command.owner === "client" && command.name === "settings")).toBe(true);
		await handle.command({ type: "get_state" });
		expect(handle.getState()).toMatchObject({
			cwd: "/tmp/project",
			availableToolNames: ["read", "lsp"],
		});
	});
	test("reloads a persisted session before reattaching after reconnect", async () => {
		const transport = new Transport();
		const handle = remote(transport);
		await handle.whenReady();
		const replayed: string[] = [];
		handle.subscribe(event => replayed.push(event.type));
		transport.emitSnapshot({
			...transport.state,
			state: "reconnecting",
			attempt: 1,
		} as DaemonConnectionSnapshot);
		transport.attachFrames = [{ type: "event", seq: 1, event: { type: "agent_start" } }];
		const abort = handle.abort();
		transport.emitSnapshot({
			...transport.state,
			state: "connected",
		} as DaemonConnectionSnapshot);
		await abort;
		expect(replayed).toContain("agent_start");
		expect(handle.state.isStreaming).toBe(false);
		expect(transport.requests.map(request => request.operation)).toEqual([
			"session_load",
			"attach",
			"session_load",
			"attach",
			"snapshot_ack",
			"session_command",
		]);
		expect(transport.requests[3]?.payload.lastSeq).toBe(0);
	});
	test("accepts replacement daemon events when its sequence restarts", async () => {
		const transport = new Transport();
		transport.emitSnapshot({ ...transport.state, daemonId: "old-daemon" } as DaemonConnectionSnapshot);
		const handle = remote(transport);
		await handle.whenReady();
		transport.emitEvent({
			v: 1,
			tag: "event",
			sessionId: "s",
			seq: 1,
			event: { type: "agent_start" },
		});
		transport.emitEvent({
			v: 1,
			tag: "event",
			sessionId: "s",
			seq: 2,
			event: { type: "agent_end" },
		});
		const terminalOutput: string[] = [];
		handle.subscribe(event => {
			if (event.type === "terminal_output") terminalOutput.push(event.data);
		});

		transport.emitSnapshot({
			state: "reconnecting",
			shard: { profile: "test" },
			attempt: 1,
		});
		transport.attachFrames = [{ type: "event", seq: 1, event: { type: "terminal_output", data: "fresh" } }];
		const abort = handle.abort();
		transport.emitSnapshot({
			...transport.state,
			state: "connected",
			daemonId: "replacement-daemon",
		} as DaemonConnectionSnapshot);

		await abort;
		expect(terminalOutput).toEqual(["fresh"]);
		const reattach = transport.requests.filter(request => request.operation === "attach").at(-1);
		expect(reattach?.payload.lastSeq).toBe(0);
	});
	test("retries transient reattach failures while the replacement daemon remains connected", async () => {
		const transport = new Transport();
		const handle = remote(transport);
		await handle.whenReady();
		transport.emitSnapshot({
			...transport.state,
			state: "reconnecting",
			attempt: 1,
		} as DaemonConnectionSnapshot);
		transport.attachFailures = 2;
		const abort = handle.abort();
		transport.emitSnapshot({
			...transport.state,
			state: "connected",
		} as DaemonConnectionSnapshot);

		await expect(abort).resolves.toBeUndefined();
		expect(handle.connectionState).toBe("connected");
		expect(transport.requests.filter(request => request.operation === "attach")).toHaveLength(4);
	});

	test("recreates an unpersisted session after shard replacement", async () => {
		const transport = new Transport();
		transport.loadNotFound = true;
		let recoveries = 0;
		const handle = new RemoteSessionHandle(transport as unknown as DaemonClient, "s", {
			attachmentId: "a",
			recover: async () => {
				recoveries++;
			},
		});
		await handle.whenReady();
		expect(recoveries).toBe(1);
		expect(transport.requests.map(request => request.operation)).toEqual(["session_load", "attach"]);
	});
	test("applies snapshot frames returned by attach", async () => {
		const transport = new Transport();
		transport.attachFrames = [
			{ type: "snapshot_begin", barrierSeq: 1 },
			{ type: "snapshot_chunk", barrierSeq: 1, index: 0, chunk: state },
			{ type: "snapshot_end", barrierSeq: 1, nextSeq: 2 },
		];
		const handle = remote(transport);
		await handle.whenReady();
		expect(handle.state.messageCount).toBe(2);
	});
	test("hydrates immutable transcript entries and replaces them on a later snapshot", async () => {
		const transport = new Transport();
		const header = {
			type: "session",
			id: "s",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: "/tmp",
		};
		const entries = [
			{
				type: "message",
				id: "u",
				parentId: null,
				timestamp: "1",
				message: { role: "user", content: "hello" },
			},
			{
				type: "message",
				id: "a",
				parentId: "u",
				timestamp: "2",
				message: { role: "assistant", content: [] },
			},
			{
				type: "message",
				id: "t",
				parentId: "a",
				timestamp: "3",
				message: { role: "toolResult", content: [] },
			},
		] as unknown as SessionEntry[];
		transport.attachFrames = [
			{ type: "snapshot_begin", barrierSeq: 1 },
			{
				type: "snapshot_chunk",
				barrierSeq: 1,
				index: 0,
				chunk: { ...state, header, entries },
			},
			{ type: "snapshot_end", barrierSeq: 1, nextSeq: 2 },
		];
		const handle = remote(transport);
		await handle.whenReady();
		expect(handle.snapshot.header?.id).toBe("s");
		expect(handle.snapshot.entries.map(entry => entry.id)).toEqual(["u", "a", "t"]);
		expect(Object.isFrozen(handle.snapshot.entries)).toBe(true);
		transport.emitFrame(snapshotFrame("snapshot_begin", { barrierSeq: 2 }));
		transport.emitFrame(
			snapshotFrame("snapshot_chunk", {
				barrierSeq: 2,
				index: 0,
				chunk: { ...state, header, entries: [entries[0]] },
			}),
		);
		transport.emitFrame(snapshotFrame("snapshot_end", { barrierSeq: 2, nextSeq: 3 }));
		expect(handle.snapshot.entries.map(entry => entry.id)).toEqual(["u"]);
	});
	test("restarts snapshots using the previous barrier field", async () => {
		const transport = new Transport();
		const handle = remote(transport);
		await Promise.resolve();
		transport.emitFrame(snapshotFrame("snapshot_begin", { barrierSeq: 2 }));
		transport.emitFrame(
			snapshotFrame("snapshot_restart", {
				previousBarrierSeq: 2,
				reason: "gap",
			}),
		);
		transport.emitFrame(
			snapshotFrame("snapshot_chunk", {
				barrierSeq: 2,
				index: 0,
				chunk: state,
			}),
		);
		expect(handle.state.messageCount).toBe(0);
		transport.emitFrame(snapshotFrame("snapshot_begin", { barrierSeq: 4 }));
		transport.emitFrame(
			snapshotFrame("snapshot_chunk", {
				barrierSeq: 4,
				index: 0,
				chunk: state,
			}),
		);
		transport.emitFrame(snapshotFrame("snapshot_end", { barrierSeq: 4, nextSeq: 5 }));
		expect(handle.state.messageCount).toBe(2);
	});
	test("bounds parked commands when the daemon never reconnects", async () => {
		const transport = new Transport();
		const handle = new RemoteSessionHandle(transport as unknown as DaemonClient, "s", {
			attachmentId: "a",
			reconnectWaitMs: 20,
		});
		await handle.whenReady();

		// Attached handle observes an outage: the reconnect gate parks senders.
		transport.emitSnapshot({ state: "reconnecting", shard: { profile: "test" }, attempt: 1 });

		// The daemon never comes back: the parked command must fail at the
		// bound — this is the "stuck forever, cannot even close" regression.
		const started = performance.now();
		await expect(handle.abort()).rejects.toThrow("did not reconnect within 20ms");
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test("wakes parked commands immediately when the client closes", async () => {
		const transport = new Transport();
		let closed = false;
		Object.defineProperty(transport, "closed", { get: () => closed });
		const handle = new RemoteSessionHandle(transport as unknown as DaemonClient, "s", {
			attachmentId: "a",
			reconnectWaitMs: 60_000,
		});
		await handle.whenReady();

		transport.emitSnapshot({ state: "reconnecting", shard: { profile: "test" }, attempt: 1 });
		const parked = handle.abort();

		// A closed client never reconnects: the unavailable snapshot must wake
		// the parked sender instantly instead of waiting out the 60s bound.
		closed = true;
		transport.emitSnapshot({ state: "unavailable", shard: { profile: "test" } });

		const started = performance.now();
		await expect(parked).rejects.toThrow("disconnected");
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	test("dispose settles promptly during an outage and unblocks parked senders", async () => {
		const transport = new Transport();
		const handle = new RemoteSessionHandle(transport as unknown as DaemonClient, "s", {
			attachmentId: "a",
			reconnectWaitMs: 60_000,
		});
		await handle.whenReady();

		transport.emitSnapshot({ state: "reconnecting", shard: { profile: "test" }, attempt: 1 });
		// Attach the rejection probe immediately: the parked sender fails the
		// moment dispose wakes the gate, before the final assertion runs.
		let parkedError: Error | undefined;
		const parked = handle.abort().catch((error: unknown) => {
			parkedError = error instanceof Error ? error : new Error(String(error));
		});

		// Teardown must never wait out the reconnect bound: detach wakes the
		// gate first, then fails fast on the disconnected transport.
		const started = performance.now();
		await expect(handle.dispose()).rejects.toThrow("disconnected");
		expect(performance.now() - started).toBeLessThan(300);
		await parked;
		expect(parkedError?.message).toContain("disconnected");
	});

	test("fails commands while disconnected and preserves extension responses", async () => {
		const transport = new Transport();
		const handle = remote(transport);
		await Promise.resolve();
		transport.disconnect();
		await expect(handle.abort()).rejects.toThrow("disconnected");
		transport.state = {
			state: "connected",
			shard: { profile: "test" },
			serverVersion: "1",
			protocolVersion: 1,
			sessionCount: 1,
			attachmentCount: 1,
			protectedJobCount: 0,
			uptimeMs: 1,
		};
		for (const listener of transport.snapshotListeners) listener(transport.state);
		await handle.respondExtensionUI({
			type: "extension_ui_response",
			id: "ui-1",
			value: "yes",
		});
		await handle.respondHostTool({
			type: "host_tool_result",
			id: "tool-1",
			result: { content: [{ type: "text", text: "ok" }] },
		});
		await handle.respondHostUri({
			type: "host_uri_result",
			id: "uri-1",
			content: "ok",
		});
		expect(transport.requests.slice(-3).map(request => request.payload.command)).toEqual([
			{ type: "extension_ui_response", id: "ui-1", value: "yes" },
			{
				type: "host_tool_result",
				id: "tool-1",
				result: { content: [{ type: "text", text: "ok" }] },
			},
			{ type: "host_uri_result", id: "uri-1", content: "ok" },
		]);
	});
	test("preserves coalescing queue modes through daemon commands", async () => {
		const transport = new Transport();
		const handle = remote(transport);
		await handle.whenReady();
		await handle.setSteeringMode("coalescing");
		await handle.setFollowUpMode("coalescing");
		expect(handle.state).toMatchObject({
			steeringMode: "coalescing",
			followUpMode: "coalescing",
		});
		expect(transport.requests.slice(-2).map(request => request.payload.command)).toMatchObject([
			{ type: "set_steering_mode", mode: "coalescing" },
			{ type: "set_follow_up_mode", mode: "coalescing" },
		]);
	});
});

describe("LocalSessionHandle", () => {
	test("forwards prompt and projects state", async () => {
		const calls: string[] = [];
		const fake = {
			agent: {
				getSteeringMode: () => "all",
				getFollowUpMode: () => "all",
				getInterruptMode: () => "immediate",
			},
			model,
			thinkingLevel: "medium",
			isFastModeEnabled: () => false,
			isFastModeActive: () => false,
			isStreaming: false,
			isCompacting: false,
			sessionFile: undefined,
			sessionId: "local",
			sessionName: undefined,
			autoCompactionEnabled: true,
			state: { messages: [] },
			queuedMessageCount: 0,
			getTodoPhases: () => [],
			getContextUsage: () => undefined,
			prompt: async (text: string) => {
				calls.push(text);
				return true;
			},
			subscribe: () => () => {},
		} as unknown as AgentSession;
		const handle = new LocalSessionHandle(fake);
		await expect(handle.prompt("hello")).resolves.toBe(true);
		expect(calls).toEqual(["hello"]);
		expect(handle.state.sessionId).toBe("local");
	});
});
