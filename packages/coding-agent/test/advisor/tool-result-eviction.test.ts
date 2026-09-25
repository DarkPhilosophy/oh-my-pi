// Unit tests for the advisor's stale tool-result eviction
// (src/advisor/tool-result-eviction.ts). Covers what the advisor's context
// maintenance depends on: only oversized, still-live tool results are blanked,
// and the cut is the one that actually pays for the prompt-cache rewrite it
// forces.
import { describe, expect, it } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";

import { evictStaleToolResults } from "../../src/advisor/tool-result-eviction";

const tokenizer = new Tokenizer();

function text(approxTokens: number): string {
	// ~4 bytes per token under either estimator; exact size is asserted by the
	// tests through the tokenizer itself, this only sets the scale.
	return "lorem ipsum dolor sit amet ".repeat(Math.ceil((approxTokens * 4) / 27));
}

function toolResult(toolCallId: string, body: string, toolName = "read"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: body }],
		isError: false,
		timestamp: 1,
	} as AgentMessage;
}

function assistantText(body: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: body }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	} as AgentMessage;
}

function userDelta(body: string): AgentMessage {
	return { role: "user", content: body, timestamp: 1 } as AgentMessage;
}

function stub(originalTokens: number): string {
	return `[Stale result elided - ${originalTokens} tokens]`;
}

/** The message union hides `content`/`prunedAt` behind roles that lack them. */
function view(message: AgentMessage): { content: unknown; prunedAt?: number } {
	return message as unknown as { content: unknown; prunedAt?: number };
}

describe("evictStaleToolResults", () => {
	it("blanks the tail review's oversized result and leaves everything else verbatim", () => {
		const bigBody = text(2_000);
		const messages = [
			userDelta("review 1 delta"),
			assistantText("investigating"),
			toolResult("t1", bigBody),
			assistantText("done"),
			// The advise acknowledgement is well under the 50-token floor: blanking
			// it would cost more than it recovers.
			toolResult("t2", "Note delivered to the primary agent.", "advise"),
		];
		const bigTokens = tokenizer.countMessage(messages[2]);
		const ackTokens = tokenizer.countMessage(messages[4]);
		expect(bigTokens).toBeGreaterThan(500);
		expect(ackTokens).toBeLessThan(50);

		const result = evictStaleToolResults(messages, tokenizer);

		expect(result.evicted).toBe(1);
		expect(result.tokensSaved).toBe(bigTokens - tokenizer.countTokens(stub(bigTokens)));
		expect(view(messages[2]).content).toEqual([{ type: "text", text: stub(bigTokens) }]);
		expect(view(messages[2]).prunedAt).toBeGreaterThan(0);
		// Deltas, assistant turns and the sub-floor ack are untouched.
		expect(view(messages[0]).content).toBe("review 1 delta");
		expect(view(messages[1]).content).toEqual([{ type: "text", text: "investigating" }]);
		expect(view(messages[4]).content).toEqual([{ type: "text", text: "Note delivered to the primary agent." }]);
		expect(view(messages[4]).prunedAt).toBeUndefined();
	});

	it("does not reach back past a review's worth of rewrite for a small result", () => {
		const messages = [
			toolResult("old", text(60)),
			assistantText(text(3_000)),
			userDelta(text(3_000)),
			assistantText("ok"),
			toolResult("new", text(5_000)),
		];
		const oldTokens = tokenizer.countMessage(messages[0]);
		const newTokens = tokenizer.countMessage(messages[4]);
		expect(oldTokens).toBeGreaterThanOrEqual(50);

		const result = evictStaleToolResults(messages, tokenizer);

		expect(result.evicted).toBe(1);
		expect(result.tokensSaved).toBe(newTokens - tokenizer.countTokens(stub(newTokens)));
		expect(view(messages[4]).content).toEqual([{ type: "text", text: stub(newTokens) }]);
		// Reclaiming ~60 tokens would force a rewrite of the 6k tokens behind it.
		expect(view(messages[0]).prunedAt).toBeUndefined();
		expect(view(messages[0]).content).toEqual([{ type: "text", text: text(60) }]);
	});

	it("leaves a result whose rewrite costs more than it saves", () => {
		const messages = [assistantText(text(3_000)), toolResult("t1", text(60)), assistantText(text(3_000))];

		const result = evictStaleToolResults(messages, tokenizer);

		expect(result).toEqual({ evicted: 0, tokensSaved: 0, coveredTokensSaved: 0 });
		expect(view(messages[1]).prunedAt).toBeUndefined();
	});

	it("is idempotent: an already-evicted context has nothing left to reclaim", () => {
		const messages = [userDelta("review 1 delta"), assistantText("investigating"), toolResult("t1", text(2_000))];
		const first = evictStaleToolResults(messages, tokenizer);
		expect(first.evicted).toBe(1);
		const stubbed = view(messages[2]).content;
		const prunedAt = view(messages[2]).prunedAt;

		const second = evictStaleToolResults(messages, tokenizer);

		expect(second).toEqual({ evicted: 0, tokensSaved: 0, coveredTokensSaved: 0 });
		expect(view(messages[2]).content).toBe(stubbed);
		expect(view(messages[2]).prunedAt).toBe(prunedAt);
	});

	it("reports only savings the provider anchor still counts", () => {
		const build = () => [
			userDelta("review 1 delta"),
			assistantText("investigating"),
			toolResult("before", text(2_000)),
			assistantText("anchor"),
			userDelta("review 2 delta"),
			toolResult("after", text(2_000)),
		];

		// No anchor: everything is counted locally, so nothing needs correcting.
		const none = evictStaleToolResults(build(), tokenizer, -1);
		expect(none.evicted).toBe(2);
		expect(none.coveredTokensSaved).toBe(0);

		// Anchor at index 3 covers the earlier result, not the later one.
		const anchored = build();
		const beforeTokens = tokenizer.countMessage(anchored[2]);
		const some = evictStaleToolResults(anchored, tokenizer, 3);
		expect(some.evicted).toBe(2);
		expect(some.coveredTokensSaved).toBe(beforeTokens - tokenizer.countTokens(stub(beforeTokens)));
		expect(some.coveredTokensSaved).toBeLessThan(some.tokensSaved);
	});
});
