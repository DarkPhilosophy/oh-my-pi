/**
 * Contract: a daemon-hosted session runs on its own worker thread, so a
 * session that stalls its event loop must not stall the daemon's other
 * clients — nor its own transport once it unblocks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonClient } from "../src/daemon/client";
import { DaemonServer } from "../src/daemon/server";
import { createWorkerSessionRuntime } from "../src/daemon/session-worker";
import { RemoteSessionHandle } from "../src/session/session-handle";

const FIXTURE_URL = new URL("./fixtures/daemon-session-worker-fixture.ts", import.meta.url).href;
const BLOCK_MS = 1_500;
/**
 * A probe served while another session is blocked must finish well inside
 * the block window; anything near BLOCK_MS means it waited on that session.
 * Relative to the block so a loaded CI machine does not fail on absolute ms.
 */
const RESPONSIVE_MS = BLOCK_MS / 2;

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!condition() && performance.now() < deadline) await Bun.sleep(5);
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function startServer() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-worker-"));
	const runtimeDir = path.join(root, "runtime");
	const server = new DaemonServer({
		profile: "test",
		runtimeDir,
		token: "secret",
		runtimeFactory: options =>
			createWorkerSessionRuntime(
				{
					...options,
					serverControls: options.serverControls ?? { getSnapshot: () => ({ state: "direct" }) },
				},
				() => new Worker(FIXTURE_URL, { type: "module" }),
			),
	});
	await server.run();
	cleanups.push(async () => {
		await server.shutdown(true);
		await fs.rm(root, { recursive: true, force: true });
	});
	const client = new DaemonClient({ profile: "test", runtimeDir, token: "secret" });
	await client.connect();
	cleanups.push(async () => client.close());
	return { root, server, client, runtimeDir };
}

async function timed<T>(work: Promise<T>): Promise<{ result: T; ms: number }> {
	const started = performance.now();
	const result = await work;
	return { result, ms: performance.now() - started };
}

describe("daemon session worker isolation", () => {
	test("a blocked session leaves other clients and sessions responsive", async () => {
		const { root, client, runtimeDir } = await startServer();
		await client.request("session_create", { sessionId: "blocked", cwd: root });
		await client.request("session_create", { sessionId: "free", cwd: root });
		const blocked = new RemoteSessionHandle(client, "blocked");
		await blocked.whenReady();
		cleanups.push(() => blocked.dispose());
		const freeClient = new DaemonClient({ profile: "test", runtimeDir, token: "secret" });
		await freeClient.connect();
		cleanups.push(async () => freeClient.close());
		const free = new RemoteSessionHandle(freeClient, "free");
		await free.whenReady();
		cleanups.push(() => free.dispose());

		const dispatchedAt = performance.now();
		const blocking = blocked.command({ type: "block", ms: BLOCK_MS } as never);
		// Let the block command reach the worker before probing.
		await Bun.sleep(50);
		const ping = await timed(client.request("ping"));
		const list = await timed(freeClient.request("session_list"));
		const echo = await timed(free.command({ type: "echo", value: "still-alive" } as never));
		// Always settle the block so a failed probe assertion cannot leave a
		// pending request to reject as "client closed" during cleanup.
		const blockedResult = await blocking.catch(error => error);
		const blockedMs = performance.now() - dispatchedAt;

		expect(ping.ms).toBeLessThan(RESPONSIVE_MS);
		expect(list.ms).toBeLessThan(RESPONSIVE_MS);
		expect(echo.ms).toBeLessThan(RESPONSIVE_MS);
		expect(echo.result).toEqual({ echoed: "still-alive" });
		expect(blockedResult).toEqual({ blockedMs: BLOCK_MS });
		// The block itself really held that worker's loop for the whole window.
		expect(blockedMs).toBeGreaterThanOrEqual(BLOCK_MS);
	});

	test("events stay ordered and state stays live across a worker stall", async () => {
		const { root, client } = await startServer();
		await client.request("session_create", { sessionId: "ordered", cwd: root });
		const handle = new RemoteSessionHandle(client, "ordered");
		await handle.whenReady();
		cleanups.push(() => handle.dispose());
		const outputs: string[] = [];
		handle.subscribe(event => {
			if (event.type === "terminal_output") outputs.push(event.data);
		});

		await handle.command({ type: "echo", value: "one" } as never);
		const blocking = handle.command({ type: "block", ms: 400 } as never);
		await handle.command({ type: "echo", value: "two" } as never);
		await blocking;
		await handle.command({ type: "echo", value: "three" } as never);
		await until(() => outputs.length >= 3);
		expect(outputs).toEqual(["one", "two", "three"]);

		// Streaming state produced inside the worker is mirrored to the registry.
		expect(handle.state.isStreaming).toBe(false);
		await handle.command({ type: "prompt", message: "go" } as never);
		await until(() => handle.state.isStreaming);
		expect(handle.state.isStreaming).toBe(true);
		const listed = (await client.request("session_list")) as Array<{ sessionId: string; isStreaming: boolean }>;
		expect(listed.find(entry => entry.sessionId === "ordered")?.isStreaming).toBe(true);
		await handle.command({ type: "abort" } as never);
		await until(() => !handle.state.isStreaming);
		expect(handle.state.isStreaming).toBe(false);
	});

	test("server controls invoked inside the worker are answered by the main thread", async () => {
		const { root, client } = await startServer();
		await client.request("session_create", { sessionId: "controls", cwd: root });
		const handle = new RemoteSessionHandle(client, "controls");
		await handle.whenReady();
		cleanups.push(() => handle.dispose());
		const result = (await handle.command({ type: "sessions" } as never)) as { sessions?: string };
		expect(result.sessions).toContain("controls");
	});
});
