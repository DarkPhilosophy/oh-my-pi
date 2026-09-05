import { describe, expect, it } from "bun:test";
import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createReserveApiKeyResolver } from "../src/config/api-key-resolver";
import { Settings } from "../src/config/settings";
import { createReserveRoutingStreamFn } from "../src/session/reserve-routing";

const luna = buildModel({
	id: "gpt-5.6-luna",
	name: "Luna",
	provider: "openai-codex",
	api: "openai-codex-responses",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
function message(model: Model, error?: string): AssistantMessage {
	return {
		role: "assistant",
		model: model.id,
		provider: model.provider,
		api: model.api,
		content: error ? [] : [{ type: "text", text: "answered" }],
		stopReason: error ? "error" : "stop",
		errorMessage: error,
		timestamp: 0,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function fixture(failure?: "unavailable" | "partial" | "abort") {
	const settings = Settings.isolated({ "providers.openai-codex.useReserve": true });
	let available = true;
	let observedAt = 1;
	let rejectedAt = 0;
	const calls: Array<{ model: string; apiKey: unknown }> = [];
	const base: StreamFn = (model, _context, options) => {
		calls.push({ model: model.id, apiKey: options?.apiKey });
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message(model), content: [] } });
			if (model.id === "gpt-reserve" && failure) {
				if (failure === "partial")
					stream.push({ type: "text_delta", contentIndex: 0, delta: "started", partial: message(model) });
				const error = message(model, "429 usage limit reached");
				if (failure === "abort") error.stopReason = "aborted";
				stream.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
			} else stream.push({ type: "done", reason: "stop", message: message(model) });
		});
		return stream;
	};
	const stream = createReserveRoutingStreamFn(
		settings,
		{
			getReserveCredential: async () =>
				available && observedAt > rejectedAt ? { credentialId: 7, observedAt } : undefined,
			rejectReserveCredential: (_provider, _route, observation) => {
				rejectedAt = observation.observedAt;
			},
			getOAuthAccessByCredentialId: async (_provider, id) => {
				expect(id).toBe(7);
				return { ok: true, accessToken: "reserve-account-token", accountId: "reserve-account", credentialId: id };
			},
		},
		base,
		() => "normal-account-token",
	);
	return {
		settings,
		calls,
		stream,
		setAvailable: (value: boolean) => {
			available = value;
		},
		refresh: () => {
			observedAt++;
		},
	};
}
async function run(f: ReturnFixture, model = luna) {
	const stream = await f.stream(model, { messages: [] }, { apiKey: "normal-account-token", sessionId: "session" });
	const events: string[] = [];
	for await (const event of stream) events.push(event.type);
	return { events, result: await stream.result() };
}
type ReturnFixture = { stream: StreamFn };

describe("reserve-first routing", () => {
	it("direct reserve selection rotates only reserve accounts and stops when all are rejected", async () => {
		const rejected = new Set<number>();
		const resolver = createReserveApiKeyResolver(
			{
				getReserveCredential: async (_provider, _route, options) => {
					const credentialId = [7, 8].find(id => !rejected.has(id) && !options?.excludeCredentialIds?.has(id));
					return credentialId === undefined ? undefined : { credentialId, observedAt: 1 };
				},
				rejectReserveCredential: (_provider, _route, observation) => {
					rejected.add(observation.credentialId);
				},
				getOAuthAccessByCredentialId: async (_provider, id) => ({
					ok: true,
					accessToken: `reserve-${id}`,
					credentialId: id,
				}),
			},
			luna.provider,
			{ model: "gpt-reserve", tier: "base-model-inference" },
		);
		expect(await resolver({ error: undefined, lastChance: false })).toBe("reserve-7");
		expect(await resolver({ error: new Error("429 usage limit"), lastChance: true })).toBe("reserve-8");
		expect(await resolver({ error: new Error("429 usage limit"), lastChance: true })).toBeUndefined();
	});
	it("tries the sibling reserve account before falling back to normal Luna", async () => {
		const settings = Settings.isolated({ "providers.openai-codex.useReserve": true });
		const rejected = new Set<number>();
		const calls: unknown[] = [];
		const stream = createReserveRoutingStreamFn(
			settings,
			{
				getReserveCredential: async (_provider, _route, options) => {
					const credentialId = [7, 8].find(id => !rejected.has(id) && !options?.excludeCredentialIds?.has(id));
					return credentialId === undefined ? undefined : { credentialId, observedAt: 1 };
				},
				rejectReserveCredential: (_provider, _route, observation) => {
					rejected.add(observation.credentialId);
				},
				getOAuthAccessByCredentialId: async (_provider, id) => ({
					ok: true,
					accessToken: `account-${id}`,
					credentialId: id,
				}),
			},
			(model, _context, options) => {
				calls.push(options?.apiKey);
				const result = new AssistantMessageEventStream();
				queueMicrotask(() => {
					result.push({ type: "start", partial: { ...message(model), content: [] } });
					if (options?.apiKey === "account-7") {
						result.push({ type: "error", reason: "error", error: message(model, "429 usage limit reached") });
					} else result.push({ type: "done", reason: "stop", message: message(model) });
				});
				return result;
			},
			() => "normal-account-token",
		);
		const result = await run({ stream });
		expect(calls).toEqual(["account-7", "account-8"]);
		expect(result.result.model).toBe("gpt-reserve");
		expect(result.events).toEqual(["start", "done"]);
	});
	it("uses the eligible account for reserve and returns to Luna when its meter disappears", async () => {
		const f = fixture();
		expect((await run(f)).result.model).toBe("gpt-reserve");
		f.setAvailable(false);
		expect((await run(f)).result.model).toBe(luna.id);
		expect(f.calls).toEqual([
			{ model: "gpt-reserve", apiKey: "reserve-account-token" },
			{ model: luna.id, apiKey: "normal-account-token" },
		]);
		expect(luna.id).toBe("gpt-5.6-luna");
	});
	it("falls back once before content and does not retry a rejected stale allowance", async () => {
		const f = fixture("unavailable");
		const first = await run(f);
		expect(first.result.stopReason).toBe("stop");
		expect(first.events).toEqual(["start", "done"]);
		await run(f);
		expect(f.calls.map(call => call.model)).toEqual(["gpt-reserve", luna.id, luna.id]);
		f.refresh();
		await run(f);
		expect(f.calls.map(call => call.model)).toEqual(["gpt-reserve", luna.id, luna.id, "gpt-reserve", luna.id]);
	});
	it("does not replay a reserve turn after visible content", async () => {
		const f = fixture("partial");
		expect((await run(f)).result.stopReason).toBe("error");
		expect(f.calls.map(call => call.model)).toEqual(["gpt-reserve"]);
		expect((await run(f)).result.model).toBe(luna.id);
		expect(f.calls.map(call => call.model)).toEqual(["gpt-reserve", luna.id]);
	});
	it("never turns cancellation into a Luna retry", async () => {
		const f = fixture("abort");
		expect((await run(f)).result.stopReason).toBe("aborted");
		expect(f.calls.map(call => call.model)).toEqual(["gpt-reserve"]);
	});
	it("respects the provider preference and leaves unrelated models alone", async () => {
		const f = fixture();
		f.settings.override("providers.openai-codex.useReserve", false);
		await run(f);
		f.settings.override("providers.openai-codex.useReserve", true);
		const other = buildModel({ ...luna, id: "gpt-6-astra", reserveRoute: undefined });
		await run(f, other);
		expect(f.calls.map(call => call.model)).toEqual([luna.id, "gpt-6-astra"]);
	});
});
