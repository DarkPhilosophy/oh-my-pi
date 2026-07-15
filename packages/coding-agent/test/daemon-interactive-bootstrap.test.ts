import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bootstrapDaemonInteractive, isDefaultInteractiveArgv } from "../src/daemon/interactive-bootstrap";
import { DaemonServer } from "../src/daemon/server";
import type { RpcSessionState } from "../src/modes/rpc/rpc-types";

describe("daemon interactive bootstrap", () => {
	test("routes normal interactive OMP through the server without an activation flag", () => {
		expect(isDefaultInteractiveArgv([])).toBe(true);
		expect(isDefaultInteractiveArgv(["hello"])).toBe(true);
		expect(isDefaultInteractiveArgv(["launch", "hello"])).toBe(true);
		expect(isDefaultInteractiveArgv(["grep", "needle"])).toBe(false);
		expect(isDefaultInteractiveArgv(["--print", "hello"])).toBe(false);
	});

	test("authenticates, forwards the complete launch argv, and detaches without disposing the server runtime", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "omp-bootstrap-"));
		const runtimeDir = path.join(root, "runtime");
		const endpoint = path.join(runtimeDir, "daemon.sock");
		let disposed = false;
		let receivedArgv: string[] | undefined;
		const server = new DaemonServer({
			profile: "test",
			projectRoot: root,
			runtimeDir,
			endpoint,
			runtimeFactory: async ({ sessionId, cwd, overrides }) => {
				receivedArgv = overrides?.argv;
				return {
					sessionId: sessionId ?? "session",
					cwd,
					snapshot: () => ({
						state: { sessionId: sessionId ?? "session", cwd } as unknown as RpcSessionState,
						cwd,
						entries: [],
					}),
					session: {
						sessionId: sessionId ?? "session",
						isStreaming: false,
						prompt: async () => true,
						abort: async () => {},
						dispose: async () => {},
						subscribe: () => () => {},
					},
					command: async () => ({}),
					dispose: async () => {
						disposed = true;
					},
					subscribe: () => () => {},
				};
			},
		});
		await server.run();
		try {
			await expect(
				bootstrapDaemonInteractive({
					argv: [],
					profile: "test",
					projectRoot: root,
					runtimeDir,
					endpoint,
					token: "wrong-token",
					startTimeoutMs: 100,
				}),
			).rejects.toThrow("terminal");
			const bootstrapped = await bootstrapDaemonInteractive({
				argv: ["--model", "openai/gpt-5"],
				profile: "test",
				projectRoot: root,
				runtimeDir,
				endpoint,
				token: server.token,
			});
			expect(bootstrapped.client.snapshot.state).toBe("connected");
			expect(bootstrapped.handle.connectionState).toBe("connected");
			expect(receivedArgv).toEqual(["--model", "openai/gpt-5"]);
			await bootstrapped.handle.dispose();
			expect(disposed).toBe(false);
			bootstrapped.client.close();
		} finally {
			await server.shutdown();
		}
	});
});
