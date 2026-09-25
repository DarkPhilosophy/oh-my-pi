/**
 * Contract: a usage-limit refusal must retry the SAME model on a healthy sibling
 * account of the same provider before any model-level fallback.
 *
 * The regression this defends: a subagent (and the advisor, and a session that
 * re-minted its provider session id) streams with a credential resolved under
 * ANOTHER provider session id — the task executor forwards the parent's
 * `getApiKey` resolver verbatim — while turn-recovery reports the usage limit
 * under its own session id, with no failed bearer to attribute. With nothing
 * sticky recorded for the marking id, `markUsageLimitReached` reported
 * `switched: false`, so a live healthy account was never tried and the turn
 * fell back to a different (more expensive) model instead. Whether the marking
 * id had picked up a stray pin first was a race, which is why the same two
 * accounts sometimes rotated and sometimes did not; attribution by the bearer
 * the request actually used makes it deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const CODEX_USAGE_LIMIT = "Codex error event: The usage limit has been reached (code=usage_limit_reached)";

describe("usage-limit sibling rotation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-usage-sibling-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			authStorage?.close();
			authStorage = undefined;
			await tempDir?.remove();
		}
	});

	it("retries the same model on a healthy sibling account instead of switching model", async () => {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallbackModel = getBundledModel("openai", "gpt-4o");
		if (!primaryModel || !fallbackModel) throw new Error("Expected bundled test models to exist");

		authStorage = await AuthStorage.create(":memory:");
		// Two sibling accounts: the one serving the request is depleted, the other
		// is healthy and must pick the same model up.
		await authStorage.credentials.set(primaryModel.provider, [
			{ type: "api_key", key: "account-1" },
			{ type: "api_key", key: "account-2" },
		]);
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		const requestedCalls: string[] = [];
		const requestedKeys: Array<string | undefined> = [];
		const mock = createMockModel();
		// A subagent spawn inherits the PARENT session's credential resolver, so the
		// bearer is resolved under an id the child never marks usage against.
		const agent = new Agent({
			getApiKey: model => authStorage!.getApiKey(model.provider, "parent-provider-session"),
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedCalls.push(`${model.provider}/${model.id}`);
				requestedKeys.push(typeof options?.apiKey === "string" ? options.apiKey : undefined);
				if (requestedCalls.length === 1) mock.push({ throw: new Error(CODEX_USAGE_LIMIT) });
				else mock.push({ content: ["recovered on the sibling account"] });
				return mock.stream(model, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxRetries": 2,
			"retry.modelFallback": true,
			"retry.fallbackChains": {
				[`${primaryModel.provider}/${primaryModel.id}`]: [`${fallbackModel.provider}/${fallbackModel.id}`],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			// Pinned, and deliberately NOT the id the request resolved under: this
			// id selects the OTHER account, so attributing the refusal to the
			// marking session instead of the request's bearer blocks the healthy
			// sibling and the assertions below fail either way.
			providerSessionId: "child-f",
		});

		await session.prompt("Prompt that hits the account's usage cap");
		await session.waitForIdle();

		expect(requestedCalls).toHaveLength(2);
		// Same model on both attempts: no fallback-chain switch.
		expect(requestedCalls).toEqual([
			`${primaryModel.provider}/${primaryModel.id}`,
			`${primaryModel.provider}/${primaryModel.id}`,
		]);
		// The refusal was attributed to the account that served it, so that account
		// is now blocked and no session selects it while the block holds — the
		// retry therefore ran on the healthy sibling.
		// "account-1" is the deterministic first pick for this pinned resolver id;
		// the retry must leave it for the sibling.
		expect(requestedKeys).toEqual(["account-1", "account-2"]);
		// The refusal was attributed to the account that served it, so that account
		// stays blocked: the very id the request resolved under now yields the
		// healthy sibling instead.
		expect(await authStorage.getApiKey(primaryModel.provider, "parent-provider-session")).toBe("account-2");
		expect(session.model?.id).toBe(primaryModel.id);
	}, 30_000);
});
