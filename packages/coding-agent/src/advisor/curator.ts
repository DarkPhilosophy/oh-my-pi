import { type ChoiceQuestion, type Model, type NoulQuestion } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { resolveJudge } from "../judgment";
import curatorAddressedPrompt from "../prompts/advisor/curator-addressed.md" with { type: "text" };
import curatorActionPrompt from "../prompts/advisor/curator-action.md" with { type: "text" };
import { ONLINE_MEMORY_MODEL_KEY } from "../tiny/models";
import type { AdvisorSeverity } from "@oh-my-pi/pi-tui/chat/messages";
export interface AdvisorCuratorCandidate {
	id: string;
	note: string;
	severity?: AdvisorSeverity;
	advisor?: string;
	coveredTurn: number;
}
export interface AdvisorCuratorContext {
	revision: number;
	currentTurn: number;
	recentPrimaryMessages: string;
}
export type AdvisorCuratorAction = "keep" | "drop" | "merge";
export interface AdvisorCuratorDecision {
	candidateId: string;
	action: AdvisorCuratorAction;
	mergeInto?: string;
	severity?: "nit" | "concern";
}
export interface AdvisorCuratorResult {
	revision: number;
	decisions: readonly AdvisorCuratorDecision[];
}
export interface CurateAdvisorCandidatesOptions {
	settings: Settings;
	registry: ModelRegistry;
	candidates: readonly AdvisorCuratorCandidate[];
	context: AdvisorCuratorContext;
	model?: Model;
	sessionId?: string;
	signal?: AbortSignal;
}
const ADDRESSED_QUESTION: NoulQuestion = { type: "noul", instructions: curatorAddressedPrompt.trim() };
const GROUP_QUESTION: ChoiceQuestion<"keep" | "merge"> = {
	type: "choice",
	instructions: curatorActionPrompt.trim(),
	criteria: {
		keep: "This candidate raises a materially distinct issue and must remain separate.",
		merge: "This candidate raises the same underlying issue as another candidate in the batch.",
	},
};
function severityRank(severity: AdvisorSeverity | undefined): number {
	return severity === "concern" ? 2 : severity === "nit" ? 1 : 0;
}
function representative(a: AdvisorCuratorCandidate, b: AdvisorCuratorCandidate): AdvisorCuratorCandidate {
	const rank = severityRank(a.severity) - severityRank(b.severity);
	if (rank !== 0) return rank > 0 ? a : b;
	if (a.coveredTurn !== b.coveredTurn) return a.coveredTurn > b.coveredTurn ? a : b;
	return a.id < b.id ? a : b;
}
export async function curateAdvisorCandidates(options: CurateAdvisorCandidatesOptions): Promise<AdvisorCuratorResult> {
	const { candidates, context } = options;
	const keep = (): AdvisorCuratorResult => ({
		revision: context.revision,
		decisions: candidates.map(candidate => ({ candidateId: candidate.id, action: "keep" })),
	});
	if (candidates.length === 0 || options.settings.get("advisor.curator") === "off") return keep();
	try {
		const judge = resolveJudge({
			settings: options.settings,
			registry: options.registry,
			sessionModel: options.model,
			sessionId: options.sessionId,
		});
		const state = {
			recent_primary_work: context.recentPrimaryMessages,
			candidates: candidates.map(candidate => ({
				id: candidate.id,
				note: candidate.note,
				severity: candidate.severity ?? "nit",
				advisor: candidate.advisor ?? "default",
				covered_turn: candidate.coveredTurn,
			})),
		};
		const questions: Record<string, NoulQuestion | ChoiceQuestion<"keep" | "merge">> = {};
		for (const candidate of candidates) {
			questions[`addressed:${candidate.id}`] = ADDRESSED_QUESTION;
			questions[`group:${candidate.id}`] = GROUP_QUESTION;
		}
		const result = await judge.judge({ state, questions }, { signal: options.signal });
		const active = candidates.filter(candidate => {
			const answer = result.answers[`addressed:${candidate.id}`];
			return answer?.type !== "noul" || answer.noul < 0.5;
		});
		const decisions: AdvisorCuratorDecision[] = candidates.map(candidate => {
			const answer = result.answers[`addressed:${candidate.id}`];
			return { candidateId: candidate.id, action: answer?.type === "noul" && answer.noul >= 0.5 ? "drop" : "keep" };
		});
		// Every candidate the judge flags as a restatement joins ONE group. Doing
		// this pairwise would let two candidates elect each other and produce a
		// cycle with no surviving note, so the group's representative is chosen
		// once and is the only member that stays.
		const merging = active.filter(candidate => {
			const answer = result.answers[`group:${candidate.id}`];
			return answer?.type === "choice" && answer.choice === "merge";
		});
		if (merging.length > 1) {
			const target = merging.reduce(representative);
			for (const candidate of merging) {
				if (candidate.id === target.id) continue;
				const decision = decisions.find(entry => entry.candidateId === candidate.id)!;
				decision.action = "merge";
				decision.mergeInto = target.id;
			}
		}
		return { revision: context.revision, decisions };
	} catch (error) {
		logger.debug("advisor curator failed open", { error: error instanceof Error ? error.message : String(error) });
		return keep();
	}
}
export function attributeMergedAdvisorNote(note: string, advisors: readonly (string | undefined)[]): string {
	const sources = [...new Set(advisors.filter((advisor): advisor is string => Boolean(advisor)))];
	return sources.length === 0 ? note : `${note}\n\nAlso raised by ${sources.join(", ")}.`;
}

/**
 * Flatten one primary message into the plain text the curator judges against.
 * Only text blocks carry evidence of what the primary actually did; images and
 * binary payloads are skipped rather than described.
 */
export function advisorEvidenceText(message: { role: string; content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") parts.push(block);
		else if (isTextBlock(block)) parts.push(block.text);
	}
	return parts.join("\n");
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "text" &&
		typeof (value as { text?: unknown }).text === "string"
	);
}

/**
 * Apply curator decisions to the batch the primary will actually see.
 *
 * Notes the curator never saw (blockers) keep their place untouched. A merged
 * note contributes only its advisor name to the surviving original, so the
 * primary reads one issue with its corroboration instead of the same point
 * restated by every advisor that noticed it.
 */
export function applyAdvisorCuration<
	T extends { note: string; severity?: AdvisorSeverity; advisor?: string; curated?: boolean },
>(notes: readonly T[], curated: readonly T[], decisions: readonly AdvisorCuratorDecision[]): T[] {
	const byId = new Map(curated.map((note, index) => [String(index), note]));
	const decisionFor = new Map(decisions.map(decision => [decision.candidateId, decision]));
	const mergedSources = new Map<T, string[]>();
	for (const [id, note] of byId) {
		const decision = decisionFor.get(id);
		if (decision?.action !== "merge" || decision.mergeInto === undefined) continue;
		const target = byId.get(decision.mergeInto);
		if (target === undefined || target === note) continue;
		const sources = mergedSources.get(target) ?? [];
		if (note.advisor !== undefined) sources.push(note.advisor);
		mergedSources.set(target, sources);
	}
	const removed = new Set<T>();
	for (const [id, note] of byId) {
		const action = decisionFor.get(id)?.action;
		if (action === "drop" || (action === "merge" && !mergedSources.has(note))) removed.add(note);
	}
	return notes
		.filter(note => !removed.has(note))
		.map(note => {
			const sources = mergedSources.get(note);
			return sources === undefined
				? note
				: { ...note, note: attributeMergedAdvisorNote(note.note, sources), curated: true };
		});
}
