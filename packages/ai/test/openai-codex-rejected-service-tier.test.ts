import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { streamOpenAICodexResponses } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import * as piUtils from "@oh-my-pi/pi-utils";
import { createCodexModel } from "./helpers";

beforeEach(() => {
	vi.spyOn(piUtils, "getInstallId").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

afterEach(() => {
	vi.restoreAllMocks();
});

const token = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }), "utf8").toBase64()}.bbb`;

const context: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

const sse = (events: object[]) => `${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;

const COMPLETED = sse([
	{ type: "response.output_text.delta", delta: "Hello" },
	{
		type: "response.completed",
		response: {
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8, input_tokens_details: { cached_tokens: 0 } },
		},
	},
]);

// The shape the live Codex endpoint answers when a tier is not offered.
const TIER_REJECTED = sse([
	{
		type: "error",
		error: {
			type: "invalid_request_error",
			code: "invalid_request_error",
			message: "Unsupported service_tier: flex",
		},
	},
]);

function decode(body: RequestInit["body"]): Record<string, unknown> {
	const text = typeof body === "string" ? body : new TextDecoder().decode(Bun.zstdDecompressSync(body as Uint8Array));
	return JSON.parse(text) as Record<string, unknown>;
}

// A `/slow` flex setting made every Codex request fail once the endpoint
// stopped offering flex; the request must fall back to standard processing.
it("replays a request without a service tier the Codex endpoint rejects, and omits it afterwards", async () => {
	const model = createCodexModel("gpt-tier-probe", { preferWebsockets: false });
	const sent: unknown[] = [];
	const fetch = (async (input: string | URL, init?: RequestInit) => {
		if (!String(input).endsWith("/responses")) return new Response("not found", { status: 404 });
		const tier = decode(init?.body).service_tier;
		sent.push(tier);
		return new Response(tier === "flex" ? TIER_REJECTED : COMPLETED, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}) as FetchImpl;

	const run = () => streamOpenAICodexResponses(model, context, { apiKey: token, fetch, serviceTier: "flex" }).result();

	const first = await run();
	expect(first.stopReason).toBe("stop");
	expect(sent).toEqual(["flex", undefined]);

	sent.length = 0;
	expect((await run()).stopReason).toBe("stop");
	expect(sent).toEqual([undefined]);
});
