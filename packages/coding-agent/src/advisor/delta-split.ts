// Candidate 4 (multi-message split) pure renderer, extracted for direct unit
// testing. Renders an advisor delta as MULTIPLE user messages — one per source
// message — instead of one ever-growing user message, so the provider prompt
// cache can incrementally hit each appended message. Provider caches are
// prefix-based: a single user message whose text keeps growing invalidates the
// whole message on every turn, pinning cache_read at the instructions/tools
// boundary (observed 14491 in production, 11066 in tests). Splitting into
// per-source user messages grows cache_read with the session (verified
// experimentally: 11066 → 11091 → 11112).
//
// Each source message is rendered INDEPENDENTLY via formatSessionHistoryMarkdown
// in chunked mode (shared tool-result pairing + watchedRoleState
// over the WHOLE delta), so toolCall/toolResult pairings resolve across chunk
// boundaries and consecutive same-role collapsing is byte-identical to the old
// single-block render. Concatenating the chunk texts reproduces the old advisor
// context exactly (equivalence-tested).
//
// The heading stays on the FIRST chunk; the WIP marker stays on the LAST chunk
// (candidate 3) so a wip/final flip never changes the stable prefix.
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { buildToolResultPairing, formatSessionHistoryMarkdown } from "../session/session-history-format";

/**
 * Obfuscation surface the split renderer needs: a single text redaction pass.
 * Narrowed from the full SecretObfuscator class to the method actually
 * consumed, so tests can satisfy the contract with a typed helper instead of
 * an `as any` escape. A SecretObfuscator instance is structurally assignable.
 */
export interface AdvisorObfuscator {
	obfuscate(text: string, sharedRegexSecretValues?: ReadonlySet<string>): string;
}

/** Render options shared by the advisor single-block and multi-message paths. */
export const ADVISOR_RENDER_OPTIONS = {
	includeToolIntent: true,
	watchedRoles: true,
	expandPrimaryContext: true,
	expandEditDiffs: true,
	expandToolIO: true,
} as const;

export interface RenderAdvisorDeltaChunksOptions {
	wip: boolean;
	includeThinking: boolean;
	obfuscator?: AdvisorObfuscator;
	advisorRegexSecretValues: ReadonlySet<string>;
}

export function renderAdvisorDeltaChunks(
	delta: AgentMessage[],
	opts: RenderAdvisorDeltaChunksOptions,
): AgentMessage[] | null {
	return finishAdvisorDeltaChunks(renderAdvisorDeltaChunkTexts(delta, opts, delta.length), opts);
}

/**
 * Same output as {@link renderAdvisorDeltaChunks}, but the per-message render
 * loop yields the event loop every `sliceMessages` messages. The split runs
 * once per advisor prompt on the UI thread, and on a long delta the whole
 * loop was a multi-second block after every primary turn. Yielding between
 * slices keeps keystrokes and paints flowing; the chunk texts are identical
 * because each message renders alone against the same shared index/state.
 * Returns null when `isStale()` reports the epoch moved during a yield.
 */
export async function renderAdvisorDeltaChunksSliced(
	delta: AgentMessage[],
	opts: RenderAdvisorDeltaChunksOptions,
	sliceMessages: number,
	isStale: () => boolean,
): Promise<AgentMessage[] | null> {
	if (delta.length === 0) return null;
	const state = createChunkRenderState(delta, opts);
	const chunks: RenderedChunk[] = [];
	for (let start = 0; start < delta.length; start += sliceMessages) {
		if (start > 0) {
			await Bun.sleep(0);
			if (isStale()) return null;
		}
		const end = Math.min(delta.length, start + sliceMessages);
		for (let i = start; i < end; i++) {
			const text = state.renderChunk([delta[i]]);
			if (!text.trim()) continue;
			chunks.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
		}
	}
	// The equivalence check re-obfuscates the whole batch once; give the loop
	// a turn before it so it never lands in the same task as the last slice.
	await Bun.sleep(0);
	if (isStale()) return null;
	return finishAdvisorDeltaChunks(chunks, opts);
}

type RenderedChunk = { role: "user"; content: TextContent[]; timestamp: number };

function createChunkRenderState(delta: AgentMessage[], opts: RenderAdvisorDeltaChunksOptions) {
	const pairing = buildToolResultPairing(delta);
	const watchedRoleState = { lastLabel: undefined as string | undefined };
	const renderChunk = (chunk: AgentMessage[]): string =>
		formatSessionHistoryMarkdown(chunk, {
			...ADVISOR_RENDER_OPTIONS,
			includeThinking: opts.includeThinking,
			toolResultPairing: pairing,
			watchedRoleState,
			transformExpandedToolIO: opts.obfuscator
				? text => opts.obfuscator!.obfuscate(text, opts.advisorRegexSecretValues)
				: undefined,
		});
	return { renderChunk };
}

function renderAdvisorDeltaChunkTexts(
	delta: AgentMessage[],
	opts: RenderAdvisorDeltaChunksOptions,
	count: number,
): RenderedChunk[] {
	if (delta.length === 0) return [];
	const state = createChunkRenderState(delta, opts);
	// Concrete local chunk type: content blocks are minted here, so the WIP
	// marker append below is a plain field access (no double-cast).
	const chunks: RenderedChunk[] = [];
	for (let i = 0; i < count; i++) {
		const text = state.renderChunk([delta[i]]);
		if (!text.trim()) continue;
		chunks.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	}
	return chunks;
}

function finishAdvisorDeltaChunks(
	chunks: RenderedChunk[],
	opts: RenderAdvisorDeltaChunksOptions,
): AgentMessage[] | null {
	if (chunks.length === 0) return null;
	const heading = "### Session update";
	if (opts.obfuscator) {
		const fullText = chunks.map(chunk => chunk.content[0].text).join("\n");
		const individuallyObfuscated = chunks.map(chunk =>
			opts.obfuscator!.obfuscate(chunk.content[0].text, opts.advisorRegexSecretValues),
		);
		if (opts.obfuscator.obfuscate(fullText, opts.advisorRegexSecretValues) !== individuallyObfuscated.join("\n")) {
			return null;
		}
		for (let i = 0; i < chunks.length; i++) chunks[i].content[0].text = individuallyObfuscated[i];
	}
	chunks[0].content[0].text = `${heading}\n\n${chunks[0].content[0].text}`;
	if (opts.wip) {
		const last = chunks[chunks.length - 1];
		last.content[0].text += `\n\n---\n\n[in progress — more steps follow]`;
	}
	return chunks as AgentMessage[];
}
