import type { AgentSession } from "../session/agent-session";
import type { InteractiveMode } from "./interactive-mode";
import { invokeSkillCommandFromText, isKnownSkillCommand } from "./skill-command";
import type { SubmittedUserInput } from "./types";

export async function submitInteractiveInput(
	mode: Pick<
		InteractiveMode,
		| "markPendingSubmissionStarted"
		| "finishPendingSubmission"
		| "showError"
		| "checkShutdownRequested"
		| "skillCommands"
		| "renderOptimisticSkillMessage"
		| "clearOptimisticSkillMessage"
		| "optimisticSkillMessagePending"
	> &
		Partial<Pick<InteractiveMode, "loopPrompt" | "pauseLoop">>,
	session: Pick<AgentSession, "prompt" | "promptCustomMessage" | "resume" | "isStreaming" | "buildUserSkillPrompt">,
	input: SubmittedUserInput,
): Promise<void> {
	if (input.cancelled) {
		return;
	}

	try {
		// Honor the submission's queue intent, defaulting to followUp. Reading
		// `session.isStreaming` to decide queue-vs-fresh is NOT atomic with the
		// eventual `agent.prompt()` call inside `session.prompt()`: a background turn
		// (queued-message drain, idle compaction, goal/loop continuation timer) can
		// flip the agent busy in the gap, and a bare prompt() would then throw
		// AgentBusyError straight to an error toast even though the UI shows no
		// "Working…". Passing a behavior unconditionally is a no-op when the session
		// is genuinely idle (a fresh turn runs and the option is ignored) and queues
		// the message instead of erroring when a turn is already underway. Normal
		// user Enter carries "steer" (interrupt, matching the streaming-branch Enter);
		// background/continuation submits omit it and fall back to "followUp". The
		// resume branch below opts out by design.
		const streamingBehavior = input.streamingBehavior ?? ("followUp" as const);
		// Continue shortcuts arrive already started, without an optimistic user message.
		if (!input.started && !mode.markPendingSubmissionStarted(input)) {
			return;
		}
		const skillHost = {
			skillCommands: mode.skillCommands,
			session,
			showError: mode.showError.bind(mode),
			renderOptimisticSkillMessage: mode.renderOptimisticSkillMessage.bind(mode),
			clearOptimisticSkillMessage: mode.clearOptimisticSkillMessage.bind(mode),
			get optimisticSkillMessagePending() {
				return mode.optimisticSkillMessagePending;
			},
		};
		if (input.customType) {
			const message = {
				customType: input.customType,
				content: input.text,
				display: input.display ?? false,
				attribution: "agent" as const,
			};
			input.dispatched = await session.promptCustomMessage(message, { streamingBehavior });
		} else if (input.resume) {
			// Continue without inserting or queueing another user message.
			await session.resume();
		} else if (isKnownSkillCommand(skillHost, input.text)) {
			// Resubmitted skill text must dispatch through the skill path, or the
			// model receives a literal `/skill:` token.
			await invokeSkillCommandFromText(skillHost, input.text, streamingBehavior, {
				images: input.images,
				imageLinks: input.imageLinks,
				optimistic: true,
				propagateErrors: true,
			});
		} else {
			let forwarded = false;
			try {
				forwarded = await session.prompt(input.text, { images: input.images, streamingBehavior });
			} catch (error: unknown) {
				mode.showError(error instanceof Error ? error.message : "Unknown error occurred");
			}
			// Dispatch consumed the body locally (void custom command) or rejected
			// instead of starting a turn: when it is the armed loop body, park the
			// loop rather than resubmitting a failed or local-only body after
			// every yield. A failed body degrades to idle like any other
			// submission failure instead of error-looping.
			if (!forwarded && mode.loopPrompt === input.text) mode.pauseLoop?.();
		}
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
		mode.showError(errorMessage);
	} finally {
		mode.finishPendingSubmission(input);
		await mode.checkShutdownRequested();
	}
}
