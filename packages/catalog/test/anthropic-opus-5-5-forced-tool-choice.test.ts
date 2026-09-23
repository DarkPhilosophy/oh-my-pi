import { describe, expect, test } from "bun:test";
import { buildModel } from "../src/build";
import type { ModelSpec } from "../src/types";

// Anthropic's Opus 5.5 rejects forced selectors on the first-party API:
//   400 invalid_request_error
//   tool_choice: type "tool" and "any" are not supported for this model.
// `anthropic.ts` downgrades a forced choice to `auto` only when the resolved
// compat says the model cannot take one, so the rule — not the request
// builder — is what keeps forced turns (judgments, forced yields) alive.
function spec(id: string): ModelSpec<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 25 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	} as ModelSpec<"anthropic-messages">;
}

describe("anthropic forced tool_choice support", () => {
	test("Opus 5.5 resolves without forced tool-choice support", () => {
		expect(buildModel(spec("claude-opus-5-5")).compat.supportsForcedToolChoice).toBe(false);
	});

	test("Opus 5 keeps forced tool-choice support", () => {
		expect(buildModel(spec("claude-opus-5")).compat.supportsForcedToolChoice).toBe(true);
	});

	test("the downgrade is Opus-scoped, not Anthropic-wide", () => {
		expect(buildModel(spec("claude-sonnet-5")).compat.supportsForcedToolChoice).toBe(true);
	});
});
