import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { invalidateMessageCache, isWorthPruning } from "@oh-my-pi/pi-agent-core/compaction";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";

function createEvictionNotice(tokens: number): string {
	return `[Stale result elided - ${tokens} tokens]`;
}

export interface ToolResultEvictionResult {
	evicted: number;
	tokensSaved: number;
	/**
	 * Part of `tokensSaved` from results before `coveredBefore`: the bytes a
	 * provider usage report at that index still counts after the eviction.
	 */
	coveredTokensSaved: number;
}

/**
 * Evict the advisor's stale investigation output from prior reviews.
 *
 * An advisor re-reads its own `read`/`grep`/`glob` results on every later
 * request — measured at ~48% of carried advisor context, re-sent ~154x — while
 * the deltas it reviews and the notes it wrote (which live in `advise`
 * tool-call *arguments*, on assistant messages) carry the actual value. Only
 * `toolResult` messages are touched here; nothing else is a candidate.
 *
 * Rewriting history is not free: it costs the provider ~(cacheWrite −
 * cacheRead) ≈ 15.8x cacheRead per re-written token, while a saved token is
 * re-read on every later request. So "saved >= rewrite" pays back within ~16
 * requests (~8 reviews). That is why the cut maximizes
 * the margin f(i) = saved(i) − rewrite(i) rather than taking the deepest
 * passing cut: a big tail eviction must not reach back through several reviews
 * just to reclaim one small result sitting behind thousands of rewrite tokens.
 *
 * Mutates `messages` in place, following compaction's in-place rewrite
 * contract (blank content, `prunedAt`, cache invalidation).
 *
 * `coveredBefore` is the index of the newest provider usage anchor (or -1 when
 * there is none); savings before it are reported separately so callers can
 * correct that stale usage without double-counting locally counted results.
 */
export function evictStaleToolResults(
	messages: AgentMessage[],
	tokenizer: Tokenizer,
	coveredBefore = -1,
): ToolResultEvictionResult {
	// One backward pass over the tail, tracking the running objective:
	//   saved(i)   = Σ (tokens − stub) over candidates at index >= i
	//   rewrite(i) = Σ tokens over non-candidates after i + Σ stub over
	//                candidates at index >= i
	// i.e. exactly the bytes the provider must re-write when the cut is at i.
	let savedAcc = 0;
	let stubAcc = 0;
	let nonCandidateAcc = 0;
	let bestIndex = -1;
	let bestMargin = 0;
	let bestSaved = 0;

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const tokens = tokenizer.countMessage(message);
		const result = message.role === "toolResult" ? (message as ToolResultMessage) : undefined;
		if (!result || result.prunedAt !== undefined || !isWorthPruning(tokens)) {
			nonCandidateAcc += tokens;
			continue;
		}
		const stub = tokenizer.countTokens(createEvictionNotice(tokens));
		savedAcc += tokens - stub;
		stubAcc += stub;
		const margin = savedAcc - (nonCandidateAcc + stubAcc);
		// Strict improvement keeps the later (shallower) index on ties.
		if (margin > bestMargin) {
			bestMargin = margin;
			bestIndex = i;
			bestSaved = savedAcc;
		}
	}

	if (bestIndex < 0) return { evicted: 0, tokensSaved: 0, coveredTokensSaved: 0 };

	const prunedAt = Date.now();
	let evicted = 0;
	let coveredTokensSaved = 0;
	for (let i = bestIndex; i < messages.length; i++) {
		const message = messages[i];
		if (message.role !== "toolResult") continue;
		const result = message as ToolResultMessage;
		if (result.prunedAt !== undefined) continue;
		const tokens = tokenizer.countMessage(message);
		if (!isWorthPruning(tokens)) continue;
		const notice = createEvictionNotice(tokens);
		if (i < coveredBefore) coveredTokensSaved += tokens - tokenizer.countTokens(notice);
		result.content = [{ type: "text", text: notice }];
		result.prunedAt = prunedAt;
		invalidateMessageCache(message);
		evicted++;
	}

	return { evicted, tokensSaved: bestSaved, coveredTokensSaved };
}
