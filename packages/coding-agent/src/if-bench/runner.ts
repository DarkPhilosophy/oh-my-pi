/**
 * Turn engine for `omp if-bench`.
 *
 * One model = one growing conversation: the system prompt and every earlier
 * turn stay byte-identical, so the whole prefix is cacheable and turn N only
 * adds N new opcodes. A model keeps going until it breaks one of the two
 * contracts scored by {@link assessResponse} or exhausts `maxTurns`; the first
 * broken turn is the score, because state is carried in the model's own last
 * reply and cannot be recovered once it drifts.
 */
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	Context,
	Message,
	Model,
	ProviderSessionState,
} from "@oh-my-pi/pi-ai";
import type { BenchRuntime, BenchTarget, StreamSimpleFn } from "../cli/bench-runtime";
import { formatModelSelectorValue, formatModelString } from "../config/model-resolver";
import { shouldDisableReasoning, toReasoningEffort } from "../thinking";
import type { Action } from "./actions";
import { applyActions, initialArray, makeActions } from "./actions";
import type { CatPlacement, IfBenchFailure } from "./protocol";
import { assessResponse, buildSystemPrompt, buildTurnPrompt } from "./protocol";

/** Outcome of one turn: what was asked, what came back, and how it scored. */
export interface IfBenchTurnRecord {
	turn: number;
	/** Opcodes issued this turn (equal to the turn number). */
	actions: number;
	/** Opcodes issued across the whole thread up to and including this turn. */
	cumulativeActions: number;
	placement: CatPlacement;
	durationMs: number;
	outputTokens: number;
	cost: number;
	passed: boolean;
	failure?: IfBenchFailure;
	/** Locally computed array for this turn. */
	expected: string;
	/** Trimmed model reply, or the provider error text when the request failed. */
	response: string;
}

/** Per-model result: the surviving depth plus the turn that ended the run. */
export interface IfBenchModelReport {
	selector: string;
	model: string;
	label: string;
	turns: IfBenchTurnRecord[];
	/** Consecutive turns answered correctly. */
	turnsPassed: number;
	/** Opcodes applied correctly before the first failure. */
	actionsPassed: number;
	failure?: { turn: number; kind: IfBenchFailure; detail: string };
	durationMs: number;
	outputTokens: number;
	cost: number;
}

export interface IfBenchSummary {
	maxTurns: number;
	arrayLength: number;
	nyaMax: number;
	maxTokens: number;
	models: IfBenchModelReport[];
	/** Models that broke before reaching `maxTurns`. */
	failures: number;
}

/** Live-progress sink; every hook is optional so JSON mode can pass nothing. */
export interface IfBenchObserver {
	modelStarted?(label: string): void;
	turnStarted?(label: string, turn: number, actions: number): void;
	turnFinished?(label: string, record: IfBenchTurnRecord): void;
	modelFinished?(report: IfBenchModelReport): void;
}

export interface IfBenchRunOptions {
	targets: readonly BenchTarget[];
	runtime: BenchRuntime;
	maxTurns: number;
	arrayLength: number;
	nyaMax: number;
	maxTokens: number;
	/** Models benchmarked concurrently; each model's own turns stay sequential. */
	par: number;
	stream: StreamSimpleFn;
	now: () => number;
	randomSessionId: () => string;
	observer?: IfBenchObserver;
}

interface TurnOutcome {
	message?: AssistantMessage;
	text: string;
	error?: string;
	durationMs: number;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("");
}

function errorText(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

/** Run every target and return the ranked-input summary (ranking is the caller's job). */
export async function runIfBench(options: IfBenchRunOptions): Promise<IfBenchSummary> {
	const reports: IfBenchModelReport[] = [];
	const queue = options.targets.map((target, index) => ({ target, index }));
	const ordered: IfBenchModelReport[] = new Array(options.targets.length);

	const worker = async (): Promise<void> => {
		for (;;) {
			const next = queue.shift();
			if (!next) return;
			ordered[next.index] = await runTarget(next.target, options);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(options.par, options.targets.length)) }, worker));
	reports.push(...ordered);

	return {
		maxTurns: options.maxTurns,
		arrayLength: options.arrayLength,
		nyaMax: options.nyaMax,
		maxTokens: options.maxTokens,
		models: reports,
		failures: reports.filter(report => report.failure !== undefined).length,
	};
}

async function runTarget(target: BenchTarget, options: IfBenchRunOptions): Promise<IfBenchModelReport> {
	const { model, selector, thinking } = target;
	const label = formatModelSelectorValue(formatModelString(model), thinking);
	const report: IfBenchModelReport = {
		selector,
		model: formatModelString(model),
		label,
		turns: [],
		turnsPassed: 0,
		actionsPassed: 0,
		durationMs: 0,
		outputTokens: 0,
		cost: 0,
	};
	options.observer?.modelStarted?.(label);

	// One session id for the whole thread: keeps gateway credential affinity and
	// lets the provider reuse the prompt cache across turns.
	const sessionId = options.randomSessionId();
	const apiKey = options.runtime.modelRegistry.resolver(model, sessionId);
	const preflight = await options.runtime.modelRegistry.getApiKey(model, sessionId);
	if (!preflight) {
		report.failure = {
			turn: 0,
			kind: "provider",
			detail: `No credentials for provider "${model.provider}". Run \`omp\` and use /login, or set the provider API key.`,
		};
		options.observer?.modelFinished?.(report);
		return report;
	}

	const messages: Message[] = [];
	const context: Context = { systemPrompt: [buildSystemPrompt(options.nyaMax)], messages };
	// Owned per thread so transport-native chaining survives every turn and is
	// torn down deterministically when the thread ends.
	const providerSessionState = new Map<string, ProviderSessionState>();
	let state = initialArray(options.arrayLength);
	let cumulativeActions = 0;

	try {
		for (let turn = 1; turn <= options.maxTurns; turn += 1) {
			const actions: Action[] = makeActions(options.arrayLength, cumulativeActions, turn);
			const turnPrompt = buildTurnPrompt({
				turn,
				start: turn === 1 ? state : undefined,
				actions,
				nyaMax: options.nyaMax,
			});
			messages.push({
				role: "user",
				content: turnPrompt.content,
				timestamp: Date.now(),
				attribution: "user",
			});
			options.observer?.turnStarted?.(label, turn, actions.length);

			const expected = applyActions(state, actions);
			const outcome = await requestTurn(model, context, sessionId, apiKey, providerSessionState, target, options);
			cumulativeActions += actions.length;
			const assessment = outcome.error
				? { passed: false, failure: "provider" as IfBenchFailure }
				: assessResponse(outcome.text, expected, options.nyaMax);
			const record: IfBenchTurnRecord = {
				turn,
				actions: actions.length,
				cumulativeActions,
				placement: turnPrompt.placement,
				durationMs: outcome.durationMs,
				outputTokens: outcome.message?.usage.output ?? 0,
				cost: outcome.message?.usage.cost?.total ?? 0,
				passed: assessment.passed,
				failure: assessment.failure,
				expected,
				response: outcome.error ?? outcome.text,
			};
			report.turns.push(record);
			report.durationMs += record.durationMs;
			report.outputTokens += record.outputTokens;
			report.cost += record.cost;
			options.observer?.turnFinished?.(label, record);

			if (!record.passed) {
				report.failure = {
					turn,
					kind: record.failure ?? "format",
					detail: record.response,
				};
				break;
			}
			report.turnsPassed = turn;
			report.actionsPassed = cumulativeActions;
			state = expected;
			// Replay the model's own reply as history: state lives in that text, and
			// the provider payload keeps transport-native chaining intact.
			if (outcome.message) messages.push(outcome.message);
		}
	} finally {
		for (const state of providerSessionState.values()) state.close();
		providerSessionState.clear();
	}

	options.observer?.modelFinished?.(report);
	return report;
}

async function requestTurn(
	model: Model<Api>,
	context: Context,
	sessionId: string,
	apiKey: ApiKeyResolver,
	providerSessionState: Map<string, ProviderSessionState>,
	target: BenchTarget,
	options: IfBenchRunOptions,
): Promise<TurnOutcome> {
	const startedAt = options.now();
	const elapsed = (message?: AssistantMessage): number => {
		const duration = message?.duration ?? options.now() - startedAt;
		return Number.isFinite(duration) && duration > 0 ? duration : 0;
	};
	try {
		const stream = options.stream(model, context, {
			apiKey,
			sessionId,
			promptCacheKey: sessionId,
			maxTokens:
				model.maxTokens !== null && Number.isFinite(model.maxTokens) && model.maxTokens > 0
					? Math.min(options.maxTokens, model.maxTokens)
					: options.maxTokens,
			// Deterministic decoding: the benchmark measures capability, not sampling luck.
			temperature: 0,
			reasoning: toReasoningEffort(target.thinking),
			disableReasoning: shouldDisableReasoning(target.thinking) ? true : undefined,
			providerSessionState,
		});
		let message: AssistantMessage | undefined;
		for await (const event of stream) {
			if (event.type === "error") {
				return { text: "", error: event.error.errorMessage ?? "request failed", durationMs: elapsed() };
			}
			if (event.type === "done") message = event.message;
		}
		message ??= await stream.result();
		if (message.stopReason === "error" || message.errorMessage) {
			return { message, text: "", error: message.errorMessage ?? "request failed", durationMs: elapsed(message) };
		}
		const text = assistantText(message).trim();
		if (text.length === 0) {
			return {
				message,
				text,
				error: `provider returned no text (stop reason: ${message.stopReason ?? "unknown"})`,
				durationMs: elapsed(message),
			};
		}
		return { message, text, durationMs: elapsed(message) };
	} catch (error) {
		return { text: "", error: errorText(error), durationMs: elapsed() };
	}
}
