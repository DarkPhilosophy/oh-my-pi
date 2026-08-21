/**
 * Contract: an account-scoped provider denial raised as a RAW thrown error on an
 * advisor turn (Codex refusing a model that only one of several ChatGPT accounts
 * is entitled to) must reach the credential-rotation path, so the advisor retries
 * the same model on a sibling account instead of latching itself unavailable.
 *
 * The regression this defends: the raw-error classification carried no
 * provider/model identity, so the provider-scoped Codex pattern never matched,
 * `accountPolicyDenial` stayed false, and no rotation was ever requested.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const CODEX_DENIAL =
	"Codex error event: The 'gpt-daybreak-blue-latest' model is not supported when using Codex with a ChatGPT account. (code=invalid_request_error)";

describe("advisor account-policy rotation", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-rotate-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			for (const authStorage of authStorages.splice(0)) authStorage.close();
			await tempDir?.remove();
		}
	});

	it("requests a sibling credential for a raw Codex ChatGPT-account model denial", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const primary = createMockModel({ responses: [{ content: ["primary reply"], stopReason: "stop" }] });
		const retried = createMockModel({ responses: [{ content: [], stopReason: "stop" }] });

		let advisorAttempts = 0;
		const retryStarted = Promise.withResolvers<void>();
		const advisorStreamFn: typeof primary.stream = (...args) => {
			advisorAttempts++;
			if (advisorAttempts === 1) throw new Error(CODEX_DENIAL);
			retryStarted.resolve();
			return retried.stream(...args);
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: primary.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		settings.setModelRole("advisor", "openai-codex/gpt-daybreak-blue-latest");
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai-codex", "test-key");

		const rotations: Array<{ provider: string; modelId: unknown }> = [];
		authStorage.rotateSessionCredential = async (provider, _sessionId, options) => {
			rotations.push({ provider, modelId: options?.modelId });
			// A sibling account that does carry the model exists: report the switch
			// so the advisor retries the SAME model on the rotated credential.
			return true;
		};

		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn,
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);

		await session.prompt("hello");
		// Await the advisor's own retry signal, not a duration.
		await retryStarted.promise;

		expect(rotations).toEqual([{ provider: "openai-codex", modelId: "gpt-daybreak-blue-latest" }]);
		expect(advisorAttempts).toBe(2);
	}, 30_000);
});
