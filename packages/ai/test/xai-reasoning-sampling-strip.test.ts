import { describe, expect, test } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { applyCommonResponsesSamplingParams } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

/**
 * xAI reasoning models reject presence_penalty / frequency_penalty / stop
 * (docs.x.ai/developers/model-capabilities/text/reasoning). With grok-4.5 as
 * the xai-oauth default (and reasoning mandatory), a configured presencePenalty
 * must not reach the wire or the default model 400s.
 */
function grok45Completions(): Model<"openai-completions"> {
	return buildModel({
		id: "grok-4.5",
		name: "Grok 4.5",
		api: "openai-completions",
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 500_000,
		maxTokens: 500_000,
	});
}

function openaiGpt(): Model<"openai-completions"> {
	return buildModel({
		id: "gpt-4o-mini",
		name: "GPT-4o mini",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function createAbortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	};
}

describe("xAI reasoning sampling-param strip", () => {
	test("applyCommonResponsesSamplingParams drops presence_penalty for xAI Grok 4.5", () => {
		const model = buildModel({
			id: "grok-4.5",
			name: "Grok 4.5",
			api: "openai-responses",
			provider: "xai-oauth",
			baseUrl: "https://api.x.ai/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 500_000,
			maxTokens: 500_000,
		});
		const params: Record<string, unknown> = {};
		applyCommonResponsesSamplingParams(params as never, { presencePenalty: 0.5, temperature: 0.7, topP: 0.9 }, model);
		expect(params.presence_penalty).toBeUndefined();
		// Non-rejected sampling still flows.
		expect(params.temperature).toBe(0.7);
		expect(params.top_p).toBe(0.9);
	});

	// Control: a non-xAI model keeps presence_penalty. It must NOT be a gpt-5+/o-series
	// id — those drop every sampling param via `supportsSamplingParams` (#5606), which
	// would make this assertion pass or fail for the wrong reason.
	test("applyCommonResponsesSamplingParams still sends presence_penalty for non-xAI models", () => {
		const model = buildModel({
			id: "gpt-4.1",
			name: "GPT-4.1",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 32_768,
		});
		const params: Record<string, unknown> = {};
		applyCommonResponsesSamplingParams(params as never, { presencePenalty: 0.5 }, model);
		expect(params.presence_penalty).toBe(0.5);
	});

	test("openai-completions drops presence/frequency/stop for xAI Grok 4.5", async () => {
		const model = grok45Completions();
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		const fetchMock: FetchImpl = async () =>
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			signal: createAbortedSignal(),
			presencePenalty: 0.5,
			frequencyPenalty: 0.25,
			stopSequences: ["STOP"],
			onPayload: payload => resolve(payload as Record<string, unknown>),
		});
		const payload = await promise;
		expect(payload.presence_penalty).toBeUndefined();
		expect(payload.frequency_penalty).toBeUndefined();
		expect(payload.stop).toBeUndefined();
	});

	test("openai-completions still sends presence/frequency/stop for non-xAI models", async () => {
		const model = openaiGpt();
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		const fetchMock: FetchImpl = async () =>
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: fetchMock,
			signal: createAbortedSignal(),
			presencePenalty: 0.5,
			frequencyPenalty: 0.25,
			stopSequences: ["STOP"],
			onPayload: payload => resolve(payload as Record<string, unknown>),
		});
		const payload = await promise;
		expect(payload.presence_penalty).toBe(0.5);
		expect(payload.frequency_penalty).toBe(0.25);
		expect(payload.stop).toBe("STOP");
	});
});
