/**
 * Smart unexpected-stop detection: asks one yes/no judge question whether a
 * text-only assistant turn promised to act and then ended. The judge comes
 * from the live `judge` role chain resolved by {@link resolveJudge}.
 */
import type { AgentTelemetryConfig } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, type JudgmentState, judgeQuestions, type Model } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { type JudgmentUsage, resolveJudge, sharedJudgmentCache } from "../judgment";
import questionFile from "../prompts/judge/unexpected-stop.json" with { type: "json" };

/**
 * Yes-probability at or above which a turn counts as an unexpected stop.
 * Keyword judges answer exactly 0 or 1; TypeSafe's calibrated probability
 * lands in between, and a coin-flip message must not trigger a retry.
 */
const UNEXPECTED_STOP_THRESHOLD = 0.5;

/**
 * The yes/no `stopped` question. Criteria stay bulleted examples: on
 * lfm2-1.2b / qwen2.5-1.5b, prose criteria cost ~3 points of recall.
 */
const QUESTIONS = judgeQuestions(questionFile);

/**
 * Leading characters of the user's request shown to the judge: enough for the
 * ask and its constraints ("don't change anything") without letting a pasted
 * log crowd a small judge model's context.
 */
const REQUEST_CHARS = 2000;

/** A text-only terminal turn and the operator request it replies to. */
export interface UnexpectedStopTurn {
	/** Visible text of the assistant's terminal message. */
	message: string;
	/**
	 * The operator's latest request. Without it the judge cannot tell an answer
	 * that offers optional next steps from one that stopped short of the ask.
	 */
	request?: string;
}

export interface ClassifyUnexpectedStopDeps {
	settings: Settings;
	registry: ModelRegistry;
	sessionId: string;
	/** Active session model; last resort of the judge role chain. */
	model?: Model;
	metadataResolver?: (provider: string) => Record<string, unknown> | undefined;
	/** Session ledger for the classification's billed attempts. */
	onUsage?: (usage: JudgmentUsage) => void;
	telemetry?: AgentTelemetryConfig;
	signal?: AbortSignal;
}

/** Detects terminal turns eligible for mechanical recovery or smart classification. */
export function isUnexpectedStopCandidate(message: AssistantMessage): boolean {
	if (message.stopReason !== "stop") return false;
	let hasContent = false;
	for (const content of message.content) {
		if (content.type === "toolCall" || content.type === "image") return false;
		// Signed and unsigned reasoning-only turns belong to the bounded empty-stop path.
		if (content.type === "text" && /\S/.test(content.text)) {
			hasContent = true;
		}
	}
	return hasContent;
}

/** `true` for an unexpected stop, `false` for a normal end of turn, `undefined` when no judge could answer. */
export async function classifyUnexpectedStop(
	stop: UnexpectedStopTurn,
	deps: ClassifyUnexpectedStopDeps,
): Promise<boolean | undefined> {
	try {
		const judge = resolveJudge({
			settings: deps.settings,
			registry: deps.registry,
			sessionModel: deps.model,
			sessionId: deps.sessionId,
			metadataResolver: deps.metadataResolver,
			purpose: "unexpected-stop",
			onUsage: deps.onUsage,
			telemetry: deps.telemetry,
			cache: sharedJudgmentCache(),
		});
		const request = stop.request?.trim().slice(0, REQUEST_CHARS);
		const state: JudgmentState = request ? { request, message: stop.message } : { message: stop.message };
		const { answers } = await judge.judge(
			{ state, questions: { stopped: QUESTIONS.stopped } },
			{ signal: deps.signal },
		);
		return answers.stopped.noul >= UNEXPECTED_STOP_THRESHOLD;
	} catch (error) {
		logger.debug("unexpected-stop: classification failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
