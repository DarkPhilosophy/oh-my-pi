/**
 * Worker fixture for daemon session isolation tests. Hosts a scripted runtime
 * whose `block` command spins the worker's event loop for `ms` milliseconds —
 * the failure mode a real session produces during a large transcript rewrite
 * or renderer diff — and whose `echo` command emits a daemon event so the
 * caller can verify ordered delivery resumes afterwards.
 */
import type { AgentSessionEventListener } from "../../src/session/agent-session";
import type { DaemonSessionRuntime } from "../../src/daemon/session-runtime";
import { runDaemonSessionWorker } from "../../src/daemon/session-worker";

type FixtureCommand =
	| { type: "block"; ms: number }
	| { type: "echo"; value: string }
	| { type: "sessions" }
	| { type: "prompt"; message: string }
	| { type: "abort" };

await runDaemonSessionWorker(async options => {
	const sessionId = options.sessionId ?? `fixture-${crypto.randomUUID()}`;
	const listeners = new Set<AgentSessionEventListener>();
	let streaming = false;
	const emit = (event: unknown): void => {
		for (const listener of listeners) listener(event as never);
	};
	const runtime: DaemonSessionRuntime = {
		sessionId,
		cwd: options.cwd,
		session: {
			sessionId,
			sessionFile: options.sessionFile,
			get isStreaming() {
				return streaming;
			},
			prompt: async () => true,
			abort: async () => undefined,
			dispose: async () => undefined,
			subscribe: listener => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		},
		snapshot: () => ({ state: { sessionId } as never, cwd: options.cwd, entries: [] }),
		command: async raw => {
			const command = raw as FixtureCommand;
			switch (command.type) {
				case "block": {
					const until = performance.now() + command.ms;
					while (performance.now() < until) {
						// Busy-wait: nothing on this worker's loop may run.
					}
					return { blockedMs: command.ms };
				}
				case "echo":
					emit({ type: "terminal_output", data: command.value });
					return { echoed: command.value };
				case "sessions":
					return { sessions: await options.serverControls?.sessions?.() };
				case "prompt":
					streaming = true;
					emit({ type: "agent_start" });
					return {};
				case "abort":
					streaming = false;
					emit({ type: "agent_end" });
					return {};
			}
		},
		dispose: async () => undefined,
		subscribe: listener => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return runtime;
});
