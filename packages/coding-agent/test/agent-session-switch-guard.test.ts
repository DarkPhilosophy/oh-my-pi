import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * The daemon registry injects a transactional guard into `switchSession` so a
 * hosted session cannot `/resume` a transcript another runtime already hosts
 * (two runtimes writing one transcript). The guard reserves the target id up
 * front and must roll that reservation back on every cancelled/failed switch,
 * committing it only after the switch completes.
 */
describe("AgentSession.switchSession guard", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-switch-guard-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	afterEach(async () => {
		while (sessions.length > 0) {
			await sessions.pop()?.dispose();
		}
		for (const dir of tempDirs.splice(0)) {
			try {
				await dir.remove();
			} catch {}
		}
	});

	function buildSession(tempDir: TempDir): { session: AgentSession; sessionManager: SessionManager } {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		sessions.push(session);
		return { session, sessionManager };
	}

	async function makeTranscript(tempDir: TempDir): Promise<string> {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		await manager.flush();
		const file = manager.getSessionFile();
		await manager.close();
		if (!file) throw new Error("Expected a persisted transcript path");
		return file;
	}

	test("commits the reservation after a successful switch", async () => {
		const tempDir = TempDir.createSync("@pi-switch-guard-commit-");
		tempDirs.push(tempDir);
		const target = await makeTranscript(tempDir);
		const { session } = buildSession(tempDir);
		const guarded: string[] = [];
		let rollbackCalls = 0;
		session.setSwitchSessionGuard(async sessionPath => {
			guarded.push(sessionPath);
			return () => {
				rollbackCalls++;
			};
		});
		const switched = await session.switchSession(target);
		expect(switched).toBe(true);
		expect(guarded).toEqual([target]);
		// The reservation was consumed by the commit, not rolled back.
		expect(rollbackCalls).toBe(0);
		expect(session.sessionFile).toBe(target);
	});

	test("rejects the switch when the guard refuses the target", async () => {
		const tempDir = TempDir.createSync("@pi-switch-guard-reject-");
		tempDirs.push(tempDir);
		const target = await makeTranscript(tempDir);
		const { session, sessionManager } = buildSession(tempDir);
		const before = sessionManager.getSessionFile();
		session.setSwitchSessionGuard(async () => {
			throw new Error("Session is already hosted by another daemon runtime.");
		});
		await expect(session.switchSession(target)).rejects.toThrow("already hosted");
		// The session stayed on its original transcript.
		expect(sessionManager.getSessionFile()).toBe(before);
	});

	test("rolls the reservation back when the switch fails after claiming", async () => {
		const tempDir = TempDir.createSync("@pi-switch-guard-rollback-");
		tempDirs.push(tempDir);
		const target = await makeTranscript(tempDir);
		const { session, sessionManager } = buildSession(tempDir);
		const setSessionFile = spyOn(sessionManager, "setSessionFile").mockRejectedValue(new Error("load failed"));
		let rollbackCalls = 0;
		session.setSwitchSessionGuard(async sessionPath => {
			expect(sessionPath).toBe(target);
			return () => {
				rollbackCalls++;
			};
		});
		try {
			await expect(session.switchSession(target)).rejects.toThrow("load failed");
			expect(rollbackCalls).toBe(1);
		} finally {
			setSessionFile.mockRestore();
		}
	});

	test("a missing guard switches without any reservation", async () => {
		const tempDir = TempDir.createSync("@pi-switch-guard-none-");
		tempDirs.push(tempDir);
		const target = await makeTranscript(tempDir);
		const { session } = buildSession(tempDir);
		const switched = await session.switchSession(target);
		expect(switched).toBe(true);
		expect(session.sessionFile).toBe(target);
	});
});
