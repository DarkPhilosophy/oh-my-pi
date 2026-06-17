/**
 * Contract: consecutive plain-text user submissions on the same channel coalesce
 * into a single queued entry (newline-joined) instead of piling up as separate
 * messages — so rapid `Line1<Enter> Line2<Enter> Line3<Enter>` reads as one
 * logical message (one pending chip, one delivery, one editor-restore block).
 *
 * The merge is deliberately narrow: only a plain text-only `role:"user"` tail
 * absorbs the next plain send. Image-bearing messages, non-user queued entries
 * (skill invocations / advisor cards), and a user message that carries a hidden
 * companion notice (magic-keyword / image-description) each break the run and
 * keep their own identity.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("AgentSession queue coalescing", () => {
	let tempDir: string;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-queue-merge-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(responses: MockResponse[]): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return session;
	}

	/**
	 * Run `fn` while the session is genuinely mid-prompt (isStreaming === true), so
	 * queued messages accumulate without the idle auto-drain delivering them. The
	 * queues are cleared afterwards so the outer prompt settles with one response.
	 */
	async function duringStream<T>(target: AgentSession, fn: () => Promise<T>): Promise<T> {
		let done = false;
		let result: T | undefined;
		target.agent.setOnBeforeYield(async () => {
			if (done) return;
			done = true;
			result = await fn();
			target.agent.clearAllQueues();
		});
		await target.prompt("hello");
		return result as T;
	}

	const steeringShapes = (target: AgentSession): string[] =>
		target.agent.peekSteeringQueue().map(m => (m.role === "custom" ? m.customType : m.role));

	it("merges consecutive plain steers into one queued entry", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const steering = await duringStream(target, async () => {
			await target.steer("Line1");
			await target.steer("Line2");
			await target.steer("Line3");
			return target.getQueuedMessages().steering.slice();
		});
		expect(steering).toEqual(["Line1\nLine2\nLine3"]);
	});

	it("merges consecutive plain follow-ups into one queued entry", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const followUp = await duringStream(target, async () => {
			await target.followUp("first");
			await target.followUp("second");
			return target.getQueuedMessages().followUp.slice();
		});
		expect(followUp).toEqual(["first\nsecond"]);
	});

	it("keeps steer and follow-up channels separate", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const queued = await duringStream(target, async () => {
			await target.steer("steer one");
			await target.followUp("follow one");
			await target.steer("steer two");
			await target.followUp("follow two");
			return target.getQueuedMessages();
		});
		expect(queued.steering).toEqual(["steer one\nsteer two"]);
		expect(queued.followUp).toEqual(["follow one\nfollow two"]);
	});

	it("does not merge a plain steer into an image-bearing tail", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const shapes = await duringStream(target, async () => {
			target.agent.steer({
				role: "user",
				content: [
					{ type: "text", text: "look at [Image #1]" },
					{ type: "image", data: "QUJD", mimeType: "image/png" },
				],
				steering: true,
				attribution: "user",
				timestamp: Date.now(),
			});
			await target.steer("plain follow-up text");
			return {
				count: target.agent.peekSteeringQueue().length,
				chips: target.getQueuedMessages().steering.slice(),
			};
		});
		// Image tail keeps its own entry; the plain send is a separate queued message.
		expect(shapes.count).toBe(2);
		expect(shapes.chips).toEqual(["look at [Image #1]", "plain follow-up text"]);
	});

	it("does not merge a plain steer into a non-user (skill-like) tail", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const shapes = await duringStream(target, async () => {
			target.agent.steer({
				role: "custom",
				customType: "skill-prompt",
				content: "/skill:review",
				display: true,
				attribution: "user",
				timestamp: Date.now(),
			});
			await target.steer("plain follow-up text");
			return steeringShapes(target);
		});
		expect(shapes).toEqual(["skill-prompt", "user"]);
	});

	it("does not merge across a magic-keyword companion notice", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const result = await duringStream(target, async () => {
			// A magic-keyword prompt steered mid-stream enqueues a hidden notice
			// immediately before its user message.
			await target.prompt("ultrathink go", { streamingBehavior: "steer" });
			await target.steer("plain extra");
			return { shapes: steeringShapes(target), chips: target.getQueuedMessages().steering.slice() };
		});
		// The companioned user message stays intact; the plain send is its own entry.
		expect(result.shapes).toEqual(["ultrathink-notice", "user", "user"]);
		expect(result.chips).toEqual(["ultrathink go", "plain extra"]);
	});

	it("reports the coalesced text to prompt's onQueued callback for signature tracking", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const queuedTexts: string[] = [];
		const onQueued = (text: string) => queuedTexts.push(text);
		await duringStream(target, async () => {
			await target.prompt("L1", { streamingBehavior: "steer", onQueued });
			await target.prompt("L2", { streamingBehavior: "steer", onQueued });
			await target.prompt("L3", { streamingBehavior: "steer", onQueued });
			return null;
		});
		// Each send reports the FINAL queued text (the running merge), so the caller can
		// register the local-submit signature of the message that actually delivers.
		expect(queuedTexts).toEqual(["L1", "L1\nL2", "L1\nL2\nL3"]);
	});
});
