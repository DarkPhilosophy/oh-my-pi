import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonClient } from "../src/daemon/client";
import {
	DAEMON_MAX_FRAME_BYTES,
	DAEMON_PROTOCOL_MAJOR,
	type DaemonFrame,
	decodeDaemonFrame,
	encodeDaemonFrame,
} from "../src/daemon/protocol";
import { DaemonServer } from "../src/daemon/server";
import { DaemonSessionRegistry, RegistryError } from "../src/daemon/session-registry";
import type {
	DaemonSessionCreateOverrides,
	DaemonSessionRuntime,
	DaemonSessionSnapshot,
} from "../src/daemon/session-runtime";
import type { AgentSessionEventListener } from "../src/session/agent-session";
import { RemoteSessionHandle } from "../src/session/session-handle";

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

function fakeFactory(protectedJobCount = 0) {
	const runtimes = new Map<string, { emit(event: unknown): void; commands: string[]; disposed: boolean }>();
	const runtimeFactory = async ({
		cwd,
		sessionId,
	}: {
		cwd: string;
		sessionId?: string;
	}): Promise<DaemonSessionRuntime> => {
		const id = sessionId ?? `generated-${runtimes.size}`;
		const listeners = new Set<(event: never) => void>();
		const state: {
			emit: (event: unknown) => void;
			commands: string[];
			disposed: boolean;
		} = {
			emit: (event: unknown) => {
				const payload = event as never;
				listeners.forEach(listener => {
					listener(payload);
				});
			},
			commands: [],
			disposed: false,
		};
		runtimes.set(id, state);
		const session: DaemonSessionRuntime["session"] = {
			sessionId: id,
			isStreaming: false,
			prompt: async (text: string) => {
				state.commands.push(text);
				return true;
			},
			abort: async () => undefined,
			dispose: async () => {
				state.disposed = true;
			},
			subscribe: (listener: AgentSessionEventListener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		};
		return {
			sessionId: id,
			cwd,
			session,
			protectedJobCount: () => protectedJobCount,
			snapshot: (): DaemonSessionSnapshot => ({
				state: {
					sessionId: id,
					thinkingLevel: undefined,
					isStreaming: false,
					isCompacting: false,
					steeringMode: "all",
					followUpMode: "all",
					interruptMode: "immediate",
					autoCompactionEnabled: true,
					messageCount: state.commands.length,
					queuedMessageCount: 0,
					todoPhases: [],
				},
				cwd,
				entries: [],
			}),
			command: async command => {
				if (
					typeof command !== "object" ||
					command === null ||
					!("text" in command) ||
					typeof command.text !== "string"
				)
					throw new Error("text required");
				state.commands.push(command.text);
				return { accepted: true };
			},
			dispose: session.dispose,
			subscribe: session.subscribe,
		};
	};
	return { runtimes, runtimeFactory };
}

class FrameReader {
	#buffer = "";
	#frames: DaemonFrame[] = [];
	#waiters: Array<{ resolve: (frame: DaemonFrame) => void; reject: (error: Error) => void }> = [];

	constructor(readable: net.Socket) {
		readable.setEncoding("utf8");
		readable.on("data", chunk => {
			this.#buffer += String(chunk);
			for (;;) {
				const newline = this.#buffer.indexOf("\n");
				if (newline < 0) return;
				const line = this.#buffer.slice(0, newline);
				this.#buffer = this.#buffer.slice(newline + 1);
				if (!line) continue;
				const frame = decodeDaemonFrame(line);
				const waiter = this.#waiters.shift();
				if (waiter) waiter.resolve(frame);
				else this.#frames.push(frame);
			}
		});
		readable.on("error", error => {
			for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
		});
	}

	next(): Promise<DaemonFrame> {
		const frame = this.#frames.shift();
		if (frame) return Promise.resolve(frame);
		const deferred = Promise.withResolvers<DaemonFrame>();
		this.#waiters.push(deferred);
		return deferred.promise;
	}
}

async function connect(endpoint: string): Promise<{ socket: net.Socket; reader: FrameReader }> {
	const deferred = Promise.withResolvers<net.Socket>();
	const socket = net.createConnection({ path: endpoint });
	socket.once("connect", () => deferred.resolve(socket));
	socket.once("error", deferred.reject);
	const connected = await deferred.promise;
	return { socket: connected, reader: new FrameReader(connected) };
}

function hello(token: string, projectRoot: string, requestId = "hello"): DaemonFrame {
	return { v: DAEMON_PROTOCOL_MAJOR, tag: "hello", requestId, profile: "test", projectRoot, token };
}

async function destroyAndWait(socket: net.Socket): Promise<void> {
	const deferred = Promise.withResolvers<void>();
	socket.once("close", () => deferred.resolve());
	socket.destroy();
	await deferred.promise;
}

describe("daemon server and registry", () => {
	test("keeps independent sessions, one interactive lease, and detached work", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-registry-"));
		const fake = fakeFactory();
		const registry = new DaemonSessionRegistry({
			projectRoot: root,
			runtimeFactory: fake.runtimeFactory,
			id: (() => {
				let n = 0;
				return () => `s${++n}`;
			})(),
		});
		const first = await registry.create();
		const second = await registry.create();
		expect(registry.status().sessionCount).toBe(2);
		const sink: unknown[] = [];
		await registry.attach(first.sessionId, "a1", "interactive", frame => {
			sink.push(frame);
		});
		await expect(
			registry.attach(first.sessionId, "a2", "interactive", frame => {
				sink.push(frame);
			}),
		).rejects.toMatchObject({ code: "session_busy" });
		await registry.attach(first.sessionId, "o1", "observe", frame => {
			sink.push(frame);
		});
		await expect(registry.command(first.sessionId, "o1", { text: "no" })).rejects.toMatchObject({
			code: "session_busy",
		});
		registry.disconnect(first.sessionId, "a1");
		await registry.attach(first.sessionId, "a2", "interactive", frame => {
			sink.push(frame);
		});
		expect(registry.status().attachmentCount).toBe(2);
		expect(second.sessionId).not.toBe(first.sessionId);
		await expect(registry.create(undefined, path.join(root, "..", "outside"))).rejects.toBeInstanceOf(RegistryError);
		const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-outside-"));
		const escapeLink = path.join(root, "escape");
		await fs.symlink(outsideRoot, escapeLink);
		await expect(registry.create(undefined, escapeLink)).rejects.toMatchObject({ code: "session_scope_error" });
		await registry.dispose();
		expect(fake.runtimes.get(first.sessionId)?.disposed).toBe(true);
		expect(fake.runtimes.get(second.sessionId)?.disposed).toBe(true);
	});

	test("removes an exited hosted session while its runtime cleanup continues", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-terminal-exit-"));
		const fake = fakeFactory();
		const releaseDispose = Promise.withResolvers<void>();
		const registry = new DaemonSessionRegistry({
			projectRoot: root,
			runtimeFactory: async options => {
				const runtime = await fake.runtimeFactory(options);
				return {
					...runtime,
					dispose: async () => {
						await releaseDispose.promise;
						await runtime.dispose();
					},
				};
			},
		});
		const session = await registry.create("exiting");
		await registry.attach(session.sessionId, "interactive", "interactive", () => {});

		fake.runtimes.get(session.sessionId)?.emit({ type: "terminal_closed", reason: "exit" });
		await flushMicrotasks();

		expect(registry.list()).toEqual([]);
		expect(registry.status().attachmentCount).toBe(0);
		expect(fake.runtimes.get(session.sessionId)?.disposed).toBe(false);

		releaseDispose.resolve();
		await flushMicrotasks();
		expect(fake.runtimes.get(session.sessionId)?.disposed).toBe(true);
	});

	test("loads and resumes persisted session IDs through the injected runtime factory", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-load-"));
		const fake = fakeFactory();
		const requestedFiles: string[] = [];
		const forwarded: Array<{ cwd: string; overrides?: DaemonSessionCreateOverrides }> = [];
		const registry = new DaemonSessionRegistry({
			projectRoot: root,
			runtimeFactory: async options => {
				if (options.sessionFile) requestedFiles.push(options.sessionFile);
				forwarded.push({ cwd: options.cwd, overrides: options.overrides });
				return fake.runtimeFactory(options);
			},
			listSessions: async () => [{ id: "persisted", path: path.join(root, "persisted.jsonl"), cwd: root }],
		});
		expect((await registry.load("persisted")).sessionId).toBe("persisted");
		expect((await registry.resume("persisted")).sessionId).toBe("persisted");
		expect(requestedFiles).toEqual([path.join(root, "persisted.jsonl")]);
		const child = path.join(root, "child");
		await fs.mkdir(child);
		const overrides: DaemonSessionCreateOverrides = {
			provider: "openai",
			model: "gpt-test",
			thinkingLevel: "high",
			steeringMode: "all",
			followUpMode: "all",
		};
		await registry.create("override", child, overrides);
		expect(forwarded.at(-1)).toEqual({ cwd: child, overrides });
		await registry.close("override");
		await registry.close("persisted");
		expect(fake.runtimes.get("persisted")?.disposed).toBe(true);
	});
	test("a losing startup contender cannot remove the active daemon lease", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-owner-race-"));
		const runtimeDir = path.join(root, "runtime");
		const winner = new DaemonServer({
			profile: "test",
			projectRoot: root,
			runtimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		await winner.run();
		const loser = new DaemonServer({
			profile: "test",
			projectRoot: root,
			runtimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		try {
			await expect(loser.run()).rejects.toThrow(/already owned/);
			expect(await Bun.file(path.join(runtimeDir, "daemon.owner")).exists()).toBe(true);
			const client = new DaemonClient({
				profile: "test",
				projectRoot: root,
				runtimeDir,
				token: "secret",
			});
			try {
				await expect(client.serverStatus()).resolves.toMatchObject({ daemonId: winner.status().daemonId });
			} finally {
				client.close();
			}
		} finally {
			await winner.shutdown(true);
		}
	});
	test("releases interactive lease on EOF, replays ordered events, and gates idle shutdown", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-replay-"));
		const runtimeDir = path.join(root, "runtime");
		const fake = fakeFactory(1);
		const server = new DaemonServer({
			profile: "test",
			projectRoot: root,
			runtimeDir,
			token: "secret",
			runtimeFactory: fake.runtimeFactory,
		});
		await server.run();
		const endpoint = server.endpoint!;
		const canonicalRoot = await fs.realpath(root);
		const first = await connect(endpoint);
		first.socket.write(encodeDaemonFrame(hello("secret", canonicalRoot, "h1")));
		expect((await first.reader.next()).tag).toBe("hello_ok");
		first.socket.write(
			encodeDaemonFrame({
				v: 1,
				tag: "request",
				requestId: "create",
				operation: { op: "session_create", sessionId: "s1" },
			}),
		);
		expect((await first.reader.next()).tag).toBe("response");
		first.socket.write(
			encodeDaemonFrame({
				v: 1,
				tag: "request",
				requestId: "attach",
				operation: { op: "attach", sessionId: "s1", attachmentId: "a1", mode: "interactive" },
			}),
		);
		const initialFrames = [
			await first.reader.next(),
			await first.reader.next(),
			await first.reader.next(),
			await first.reader.next(),
		];
		expect(initialFrames.map(frame => frame.tag)).toEqual([
			"snapshot_begin",
			"snapshot_chunk",
			"snapshot_end",
			"response",
		]);
		fake.runtimes.get("s1")?.emit({ type: "message_update", text: "one" });
		expect((await first.reader.next()).tag).toBe("event");
		await destroyAndWait(first.socket);
		server.registry.disconnect("s1", "a1");
		expect(server.status().sessionCount).toBe(1);
		expect(server.status().attachmentCount).toBe(0);
		fake.runtimes.get("s1")?.emit({ type: "message_update", text: "two" });

		const second = await connect(endpoint);
		second.socket.write(encodeDaemonFrame(hello("secret", canonicalRoot, "h2")));
		expect((await second.reader.next()).tag).toBe("hello_ok");
		second.socket.write(
			encodeDaemonFrame({
				v: 1,
				tag: "request",
				requestId: "reattach",
				operation: { op: "attach", sessionId: "s1", attachmentId: "a2", mode: "interactive", lastSeq: 1 },
			}),
		);
		const replay = [await second.reader.next(), await second.reader.next()];
		expect(replay[0]?.tag).toBe("event");
		expect(replay[1]?.tag).toBe("response");
		expect(server.status().attachmentCount).toBe(1);
		const blocked = await server.shutdown();
		expect(blocked.shutdown).toBe(false);
		expect(blocked.blockers).toContain("clients");
		expect(blocked.blockers).toContain("sessions");
		expect(blocked.blockers).toContain("protected_jobs");
		await destroyAndWait(second.socket);
		await server.shutdown(true);

		const idleRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-idle-"));
		const idleServer = new DaemonServer({
			profile: "test",
			projectRoot: idleRoot,
			runtimeDir: path.join(idleRoot, "runtime"),
			token: "secret",
			runtimeFactory: fakeFactory(1).runtimeFactory,
		});
		await idleServer.run();
		await idleServer.registry.create("idle");
		const idleBlocked = await idleServer.shutdown();
		expect(idleBlocked.blockers).toContain("sessions");
		expect(idleBlocked.blockers).toContain("protected_jobs");
		await idleServer.registry.close("idle");
		expect(idleServer.idleShutdownEligible()).toBe(true);
		expect((await idleServer.shutdown()).shutdown).toBe(true);
	});

	test("authenticates before mutation and reports authoritative status over Unix socket", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-server-"));
		const runtimeDir = path.join(root, "runtime");
		const fake = fakeFactory();
		const server = new DaemonServer({
			profile: "test",
			projectRoot: root,
			runtimeDir,
			token: "secret",
			runtimeFactory: fake.runtimeFactory,
		});
		await server.run();
		const endpoint = server.endpoint!;
		const bad = await connect(endpoint);
		bad.socket.write(encodeDaemonFrame(hello("wrong", await fs.realpath(root), "bad")));
		const badResponse = await bad.reader.next();
		expect(badResponse.tag).toBe("response");
		expect(fake.runtimes.size).toBe(0);
		bad.socket.destroy();
		const incompatible = await connect(endpoint);
		incompatible.socket.write(
			`${JSON.stringify({ v: 99, tag: "hello", requestId: "version", profile: "test", projectRoot: await fs.realpath(root), token: "secret" })}\n`,
		);
		expect((await incompatible.reader.next()).tag).toBe("response");
		expect(fake.runtimes.size).toBe(0);
		incompatible.socket.destroy();

		const client = await connect(endpoint);
		const canonicalRoot = await fs.realpath(root);
		client.socket.write(encodeDaemonFrame(hello("secret", canonicalRoot)));
		expect((await client.reader.next()).tag).toBe("hello_ok");
		client.socket.write(
			encodeDaemonFrame({
				v: 1,
				tag: "request",
				requestId: "create",
				operation: {
					op: "session_create",
					sessionId: "s1",
					cwd: canonicalRoot,
					overrides: {
						provider: "openai",
						model: "gpt-test",
						thinkingLevel: "high",
						steeringMode: "all",
						followUpMode: "all",
					},
				},
			}),
		);
		expect((await client.reader.next()).tag).toBe("response");
		client.socket.write(
			encodeDaemonFrame({ v: 1, tag: "request", requestId: "status", operation: { op: "server_status" } }),
		);
		const status = await client.reader.next();
		expect(status.tag).toBe("response");
		expect(server.status().sessionCount).toBe(1);
		expect(server.status().attachmentCount).toBe(0);
		client.socket.destroy();
		const shutdown = await server.shutdown(true);
		expect(shutdown.shutdown).toBe(true);
	});
	test("buffers events emitted during attachment snapshot without a sequence gap", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-attach-race-"));
		let emit: ((event: unknown) => void) | undefined;
		let emitted = false;
		const registry = new DaemonSessionRegistry({
			projectRoot: root,
			runtimeFactory: async ({ cwd, sessionId }): Promise<DaemonSessionRuntime> => {
				const listeners = new Set<AgentSessionEventListener>();
				emit = event => {
					for (const listener of listeners) listener(event as never);
				};
				const session = {
					sessionId: sessionId ?? "race",
					prompt: async () => true,
					abort: async () => undefined,
					dispose: async () => undefined,
					subscribe: (listener: AgentSessionEventListener) => {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				} as DaemonSessionRuntime["session"];
				return {
					sessionId: session.sessionId,
					cwd,
					session,
					snapshot: (): DaemonSessionSnapshot => {
						if (!emitted) {
							emitted = true;
							emit?.({ type: "message_end" });
						}
						return {
							state: {
								sessionId: session.sessionId,
								thinkingLevel: undefined,
								isStreaming: false,
								isCompacting: false,
								steeringMode: "all",
								followUpMode: "all",
								interruptMode: "immediate",
								autoCompactionEnabled: true,
								messageCount: 0,
								queuedMessageCount: 0,
								todoPhases: [],
							},
							cwd,
							entries: [],
						};
					},
					command: async () => ({}),
					dispose: session.dispose,
					subscribe: session.subscribe,
				};
			},
		});
		await registry.create("race");
		const frames: unknown[] = [];
		const attached = await registry.attach("race", "a1", "observe", frame => {
			frames.push(frame);
		});
		expect(attached.barrierSeq).toBe(1);
		expect(attached.frames.map(frame => (frame as { type?: unknown }).type)).toEqual([
			"snapshot_begin",
			"snapshot_chunk",
			"snapshot_end",
		]);
		expect(frames.map(frame => (frame as { type?: unknown }).type)).toEqual(["event"]);
		expect((frames.at(-1) as { seq?: unknown }).seq).toBe(1);
		expect(registry.status().attachmentCount).toBe(1);
		await registry.dispose();
	});
	test("shutdown request stops when requester is the only blocker and reports live blockers", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-stop-"));
		const runtimeDir = path.join(root, "runtime");
		const server = new DaemonServer({
			profile: "test",
			projectRoot: root,
			runtimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		await server.run();
		const client = new DaemonClient({ profile: "test", projectRoot: root, runtimeDir, token: "secret" });
		await client.connect();
		const stopped = (await client.request("shutdown")) as { shutdown: boolean; blockers: string[] };
		expect(stopped).toEqual({ shutdown: true, blockers: [] });
		for (let attempt = 0; attempt < 20 && !server.closed; attempt++) await Bun.sleep(5);
		expect(server.closed).toBe(true);
		await expect(fs.stat(server.endpoint!)).rejects.toMatchObject({ code: "ENOENT" });
		client.close();

		const blockedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-stop-blocked-"));
		const blockedRuntimeDir = path.join(blockedRoot, "runtime");
		const blockedServer = new DaemonServer({
			profile: "test",
			projectRoot: blockedRoot,
			runtimeDir: blockedRuntimeDir,
			token: "secret",
			runtimeFactory: fakeFactory().runtimeFactory,
		});
		await blockedServer.run();
		const blockedClient = new DaemonClient({
			profile: "test",
			projectRoot: blockedRoot,
			runtimeDir: blockedRuntimeDir,
			token: "secret",
		});
		await blockedClient.connect();
		await blockedClient.request("session_create", { sessionId: "live" });
		const blocked = (await blockedClient.request("shutdown")) as { shutdown: boolean; blockers: string[] };
		expect(blocked.shutdown).toBe(false);
		expect(blocked.blockers).toContain("sessions");
		await blockedClient.request("session_close", { sessionId: "live" });
		expect(await blockedClient.request("shutdown")).toEqual({ shutdown: true, blockers: [] });
		blockedClient.close();
	});
	test("hydrates RemoteSessionHandle state and dispatches typed commands across reconnect", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-remote-"));
		const runtimeDir = path.join(root, "runtime");
		const model = { provider: "openai", id: "gpt-resumed", name: "gpt-resumed", api: "openai-responses" } as never;
		const todoPhases = [{ name: "ship", tasks: [{ content: "test", status: "in_progress" }] }] as never;
		const persistedTranscript = `${"x".repeat(DAEMON_MAX_FRAME_BYTES)}tail`;
		const current = {
			thinkingLevel: "high",
			steeringMode: "one-at-a-time",
			followUpMode: "one-at-a-time",
			interruptMode: "wait",
			messageCount: 7,
			queuedMessageCount: 2,
			todoPhases,
			commands: [] as string[],
		};
		const listeners = new Set<AgentSessionEventListener>();
		const emit = (event: unknown): void => {
			for (const listener of listeners) listener(event as never);
		};
		const runtimeFactory = async ({
			cwd,
			sessionId,
		}: {
			cwd: string;
			sessionId?: string;
		}): Promise<DaemonSessionRuntime> => {
			const id = sessionId ?? "remote";
			const session = {
				sessionId: id,
				prompt: async (_text: string) => {
					current.messageCount++;
					emit({ type: "message_end" });
					return true;
				},
				abort: async () => undefined,
				dispose: async () => undefined,
				subscribe: (listener: AgentSessionEventListener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
			} as DaemonSessionRuntime["session"];
			const state = (): DaemonSessionSnapshot["state"] => ({
				model,
				thinkingLevel: current.thinkingLevel as never,
				isStreaming: false,
				isCompacting: false,
				steeringMode: current.steeringMode as never,
				followUpMode: current.followUpMode as never,
				interruptMode: current.interruptMode as never,
				sessionId: id,
				autoCompactionEnabled: true,
				messageCount: current.messageCount,
				queuedMessageCount: current.queuedMessageCount,
				todoPhases: current.todoPhases,
			});
			return {
				sessionId: id,
				cwd,
				session,
				snapshot: () => ({
					state: state(),
					cwd,
					entries: [{ type: "message", text: persistedTranscript }],
				}),
				command: async command => {
					const type =
						typeof command === "object" && command !== null && "type" in command ? String(command.type) : "";
					current.commands.push(type);
					if (type === "prompt") return { agentInvoked: await session.prompt("prompt") };
					if (type === "set_todos" && typeof command === "object" && command !== null && "phases" in command) {
						current.todoPhases = command.phases as never;
						return { todoPhases: current.todoPhases };
					}
					if (
						type === "set_thinking_level" &&
						typeof command === "object" &&
						command !== null &&
						"level" in command
					)
						current.thinkingLevel = String(command.level);
					if (type === "set_steering_mode" && typeof command === "object" && command !== null && "mode" in command)
						current.steeringMode = String(command.mode) as never;
					if (
						type === "set_follow_up_mode" &&
						typeof command === "object" &&
						command !== null &&
						"mode" in command
					)
						current.followUpMode = String(command.mode) as never;
					if (
						type === "set_interrupt_mode" &&
						typeof command === "object" &&
						command !== null &&
						"mode" in command
					)
						current.interruptMode = String(command.mode) as never;
					if (
						type === "set_host_tools" ||
						type === "set_host_uri_schemes" ||
						type === "extension_ui_response" ||
						type === "host_tool_result" ||
						type === "host_tool_update" ||
						type === "host_uri_result"
					)
						return {};
					return {};
				},
				dispose: session.dispose,
				subscribe: session.subscribe,
			};
		};
		const server = new DaemonServer({
			profile: "test",
			projectRoot: root,
			runtimeDir,
			token: "secret",
			runtimeFactory,
		});
		await server.run();
		const client = new DaemonClient({ profile: "test", projectRoot: root, runtimeDir, token: "secret" });
		await client.connect();
		await client.request("session_create", { sessionId: "remote" });
		const handle = new RemoteSessionHandle(client, "remote");
		await handle.whenReady();
		expect(handle.state.model?.id).toBe("gpt-resumed");
		expect(handle.state.messageCount).toBe(7);
		expect(handle.state.steeringMode).toBe("one-at-a-time");
		expect(handle.state.todoPhases).toEqual(todoPhases);
		const persistedEntry = handle.snapshot.entries[0] as { text?: string } | undefined;
		expect(persistedEntry?.text?.length).toBe(persistedTranscript.length);
		expect(persistedEntry?.text?.endsWith("tail")).toBe(true);
		const seen: string[] = [];
		handle.subscribe(event => seen.push(String((event as { type?: unknown }).type)));
		await handle.prompt("hello");
		await handle.setThinkingLevel("high" as never);
		await handle.setSteeringMode("all");
		await handle.setFollowUpMode("all");
		await handle.setInterruptMode("immediate");
		await handle.setTodos(todoPhases);
		await handle.setHostTools([]);
		await handle.setHostUriSchemes([]);
		await handle.respondExtensionUI({ type: "extension_ui_response", id: "ui-1", cancelled: true });
		expect(current.commands).toEqual([
			"prompt",
			"set_thinking_level",
			"set_steering_mode",
			"set_follow_up_mode",
			"set_interrupt_mode",
			"set_todos",
			"set_host_tools",
			"set_host_uri_schemes",
			"extension_ui_response",
		]);
		expect(seen).toContain("message_end");
		await handle.dispose();
		const resumed = new RemoteSessionHandle(client, "remote");
		await resumed.whenReady();
		expect(resumed.state.model?.id).toBe("gpt-resumed");
		expect(resumed.state.messageCount).toBe(8);
		expect(resumed.state.todoPhases).toEqual(todoPhases);
		await resumed.dispose();
		client.close();
		await server.shutdown(true);
	});
});
