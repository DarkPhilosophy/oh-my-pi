import { describe, expect, test } from "bun:test";
import { createAgentSessionRuntime } from "../src/daemon/session-runtime";
import type { CreateAgentSessionResult } from "../src/sdk";
import {
	type AgentSession,
	type AgentSessionDisposeOptions,
	SHUTDOWN_CONSOLIDATE_BUDGET_MS,
} from "../src/session/agent-session";

describe("daemon session runtime", () => {
	test("bounds memory consolidation while disposing a hosted session", async () => {
		let disposeOptions: AgentSessionDisposeOptions | undefined;
		const runtime = await createAgentSessionRuntime({
			cwd: process.cwd(),
			sessionId: "hosted",
			createSession: async options => {
				const session = {
					sessionId: "hosted",
					isStreaming: false,
					subscribe: () => () => {},
					subscribeCommandMetadataChanged: () => () => {},
					dispose: async (received?: AgentSessionDisposeOptions) => {
						disposeOptions = received;
						await options.sessionManager?.close();
					},
				} as unknown as AgentSession;
				return {
					session,
					setToolUIContext: () => {},
				} as unknown as CreateAgentSessionResult;
			},
		});

		await runtime.dispose();

		expect(disposeOptions?.mnemopiConsolidateTimeoutMs).toBe(SHUTDOWN_CONSOLIDATE_BUDGET_MS);
	});
});
