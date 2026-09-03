import type { Agent, AgentEvent, AgentMessage, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@oh-my-pi/pi-ai";
import { GeminiHeaderRunDetector } from "@oh-my-pi/pi-ai/utils/thinking-loop";
import { type RepeatedToolCallDetection, ToolCallLoopGuard } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { EditMode } from "../utils/edit-mode";
import type { LocalProtocolOptions } from "../internal-urls";
import geminiToolReminderTemplate from "../prompts/system/gemini-tool-call-reminder.md" with { type: "text" };
import type { SecretObfuscator } from "../secrets/obfuscator";
import type { CustomMessage } from "./messages";
import type { SessionManager } from "./session-manager";
import {
	renderToolCallLoopRedirect,
	TOOL_CALL_LOOP_REDIRECT_TYPE,
	toolCallLoopRedirectDetails,
} from "./tool-call-loop-redirect";

const GEMINI_HEADER_INTERRUPT_REASON = "Interrupted: emit a tool call instead of more planning";
const GEMINI_TOOL_REMINDER_TYPE = "gemini-tool-call-reminder";

/** Capabilities borrowed by the session's streaming and loop guards. */
export interface StreamGuardsHost {
	agent: Agent;
	settings: Settings;
	sessionManager: SessionManager;
	obfuscator: SecretObfuscator | undefined;
	model(): Model | undefined;
	resolveActiveEditMode(): EditMode;
	isDisposed(): boolean;
	promptGeneration(): number;
	localProtocolOptions(): LocalProtocolOptions;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	schedulePostPromptTask(task: (signal: AbortSignal) => Promise<void>): void;
	discardAssistantTurn(message: AssistantMessage): void;
}

/** Applies the opt-in hard-abort policy for failed legacy patch previews. */
export class StreamingEditGuard {
	readonly #host: StreamGuardsHost;
	#abortTriggered = false;

	constructor(host: StreamGuardsHost) {
		this.#host = host;
	}

	/** Whether the current turn was aborted by streaming edit validation. */
	get abortTriggered(): boolean {
		return this.#abortTriggered;
	}

	/** Clears turn-scoped streaming edit state. */
	reset(): void {
		this.#abortTriggered = false;
	}

	/** Aborts a legacy patch edit when its final streamed preview cannot apply. */
	maybeAbort(event: AgentEvent): void {
		if (this.#host.resolveActiveEditMode() !== "patch") return;
		if (
			!this.#host.settings.get("edit.streamingAbort") ||
			this.#abortTriggered ||
			event.type !== "tool_stream_update" ||
			event.toolName !== "edit"
		) {
			return;
		}
		const update = event.update;
		if (
			update === null ||
			typeof update !== "object" ||
			!("streaming" in update) ||
			update.streaming !== false ||
			!("files" in update) ||
			!Array.isArray(update.files)
		) {
			return;
		}
		const files: unknown[] = update.files;
		const failed = files.find(
			(file): file is { path: string; error: string } =>
				file !== null &&
				typeof file === "object" &&
				"path" in file &&
				typeof file.path === "string" &&
				"error" in file &&
				typeof file.error === "string" &&
				file.error.length > 0,
		);
		if (failed) this.#abortPatch(event.toolCallId, failed.path, failed.error);
	}

	#abortPatch(toolCallId: string, filePath: string, error: string): void {
		this.#abortTriggered = true;
		logger.warn("Streaming edit aborted due to patch preview failure", { toolCallId, path: filePath, error });
		this.#host.agent.abort();
	}
}

/** Detects cross-turn tool loops and Gemini reasoning-header runaways. */
export class LoopGuards {
	readonly #host: StreamGuardsHost;
	#geminiHeaderDetector: GeminiHeaderRunDetector | undefined;
	#toolCallLoopGuard: ToolCallLoopGuard | undefined;
	#toolCallLoopGuardSettingsKey: string | undefined;

	constructor(host: StreamGuardsHost) {
		this.#host = host;
	}

	/** Records a completed turn and injects a redirect when calls repeat. */
	recordTurn(messages: AgentMessage[], context: AgentTurnEndContext | undefined): void {
		if (context?.message.role !== "assistant") return;
		const detection = this.#activeToolCallLoopGuard()?.recordTurn({
			message: context.message,
			toolResults: context.toolResults,
		});
		if (detection) this.#injectToolCallLoopRedirect(messages, detection);
	}

	/** Feeds a streamed assistant event to the Gemini header-runaway detector. */
	onAssistantEvent(message: AssistantMessage, event: AssistantMessageEvent): void {
		if (event.type === "thinking_start") {
			this.#geminiHeaderDetector = this.#geminiHeaderGuardActive() ? new GeminiHeaderRunDetector() : undefined;
			return;
		}
		const detector = this.#geminiHeaderDetector;
		if (!detector) return;
		if (event.type === "thinking_delta") {
			if (detector.push(event.delta)) this.#interruptGeminiHeaderRunaway(detector.count, message.timestamp);
			return;
		}
		if (event.type === "text_start" || event.type === "toolcall_start") detector.reset();
	}

	#activeToolCallLoopGuard(): ToolCallLoopGuard | undefined {
		if (this.#host.settings.get("model.toolCallLoopGuard.enabled") !== true) {
			this.#toolCallLoopGuard = undefined;
			this.#toolCallLoopGuardSettingsKey = undefined;
			return undefined;
		}
		const threshold = this.#host.settings.get("model.toolCallLoopGuard.threshold");
		const exemptTools = this.#host.settings
			.get("model.toolCallLoopGuard.exemptTools")
			.filter((tool): tool is string => typeof tool === "string" && tool.length > 0);
		const settingsKey = `${threshold}:${JSON.stringify(exemptTools)}`;
		if (!this.#toolCallLoopGuard || this.#toolCallLoopGuardSettingsKey !== settingsKey) {
			this.#toolCallLoopGuard = new ToolCallLoopGuard({ threshold, exemptTools });
			this.#toolCallLoopGuardSettingsKey = settingsKey;
		}
		return this.#toolCallLoopGuard;
	}

	#injectToolCallLoopRedirect(messages: AgentMessage[], detection: RepeatedToolCallDetection): void {
		logger.warn("cross-turn tool-call loop detected", { toolName: detection.toolName, count: detection.count });
		const content = renderToolCallLoopRedirect(detection);
		const details = toolCallLoopRedirectDetails(detection);
		const redirectMessage: CustomMessage = {
			role: "custom",
			customType: TOOL_CALL_LOOP_REDIRECT_TYPE,
			content,
			display: false,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		};
		messages.push(redirectMessage);
		if (this.#host.agent.state.messages !== messages) this.#host.agent.appendMessage(redirectMessage);
		this.#host.sessionManager.appendCustomMessageEntry(
			TOOL_CALL_LOOP_REDIRECT_TYPE,
			content,
			false,
			details,
			"agent",
		);
	}

	#geminiHeaderGuardActive(): boolean {
		const model = this.#host.model();
		return (
			process.env.PI_NO_THINKING_LOOP_GUARD !== "1" &&
			this.#host.settings.get("model.loopGuard.enabled") === true &&
			this.#host.settings.get("model.loopGuard.toolCallReminder") === true &&
			model !== undefined &&
			model.identity.class === "gemini"
		);
	}

	#interruptGeminiHeaderRunaway(headerCount: number, targetTimestamp: number): void {
		const model = this.#host.model();
		logger.warn("Gemini reasoning-header runaway; interrupting to require a tool call", {
			model: model?.id,
			provider: model?.provider,
			headers: headerCount,
		});
		this.#host.emitNotice(
			"warning",
			`Interrupted ${headerCount} planning headers with no tool call; reminded the model to issue one.`,
			"loop-guard",
		);
		this.#host.agent.abort(GEMINI_HEADER_INTERRUPT_REASON);
		const generation = this.#host.promptGeneration();
		this.#host.schedulePostPromptTask(async signal => {
			if (signal.aborted || this.#host.isDisposed() || this.#host.promptGeneration() !== generation) return;
			await this.#host.agent.waitForIdle();
			if (signal.aborted || this.#host.isDisposed() || this.#host.promptGeneration() !== generation) return;
			const aborted = this.#host.agent.state.messages.findLast(
				(message): message is AssistantMessage =>
					message.role === "assistant" && message.timestamp === targetTimestamp,
			);
			if (aborted) this.#host.discardAssistantTurn(aborted);
			const content = prompt.render(geminiToolReminderTemplate, { count: headerCount });
			const details = { headers: headerCount };
			this.#host.agent.appendMessage({
				role: "custom",
				customType: GEMINI_TOOL_REMINDER_TYPE,
				content,
				display: false,
				details,
				attribution: "agent",
				timestamp: Date.now(),
			});
			this.#host.sessionManager.appendCustomMessageEntry(
				GEMINI_TOOL_REMINDER_TYPE,
				content,
				false,
				details,
				"agent",
			);
			try {
				await this.#host.agent.continue();
			} catch (error) {
				logger.warn("gemini tool-call reminder continue failed", { error: String(error) });
			}
		});
	}
}
