import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { RenderScenario, RenderWorkflow } from "./render-workflow";

export interface RenderTestOptions {
	repeat: number;
	/** Delay between simulated provider chunks, in milliseconds. */
	delayMs: number;
	scenario?: RenderScenario;
	/** Isolate a single scripted response (1-based); labels keep the original number. */
	segment?: number;
}

/** Upper bound on simulated tool-argument deltas so a large payload stays paced, not stalled. */
const MAX_TOOL_ARG_DELTAS = 60;

export function validateRenderTestOptions(options: RenderTestOptions): void {
	if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 100) {
		throw new RangeError("Render repetitions must be an integer between 1 and 100.");
	}
	if (!Number.isInteger(options.delayMs) || options.delayMs < 1 || options.delayMs > 1000) {
		throw new RangeError("Render delay must be an integer between 1 and 1000 ms.");
	}
	if (options.segment !== undefined && (!Number.isInteger(options.segment) || options.segment < 1)) {
		throw new RangeError("Render segment must be a positive integer.");
	}
}

/** Whether a run opens with the default pass, which starts with a viewport-spanning introduction. */
export function runsDefaultPass(scenario: RenderScenario | undefined): boolean {
	return scenario === undefined || scenario === "all";
}

/** Heading for one scripted response, named after the tools it calls. */
function batchTitle(tools: readonly string[], scripted: boolean, introduction: boolean): string {
	if (introduction) return "Analysis, long-form text and one viewport-spanning code block";
	if (tools.includes("ask")) return "Interactive question — draft input, submission and dialog restoration";
	if (tools.includes("edit")) return "File changes — real snapshot validation and edit results";
	if (tools.includes("read")) return "File inspection — read the current contents before the next change";
	if (tools.includes("bash")) return "Background processing — foreground handoff and concurrent jobs";
	return scripted ? "Workflow progress" : "Completed workflow";
}

/** The line that tells the person watching what this response is about to show. */
function stepDetail(
	tools: readonly string[],
	scripted: boolean,
	streamNumber: number,
	scenario?: RenderScenario,
): string {
	if (tools.includes("ask")) {
		return "The next tool opens the question. Try draft input and submission before answering; the workflow then resumes.";
	}
	if (tools.includes("edit") && tools.length === 3) {
		return "Three edits belong to this one response. The second deliberately fails hash validation; recovery happens in a later response.";
	}
	if (tools.includes("bash") && tools.length === 10) {
		return `Ten jobs launch in this batch. Streaming ${streamNumber + 1}–${streamNumber + 4} are tool-only wait responses, with no narration between them.`;
	}
	if (scripted) {
		return `This response calls: ${tools.join(" → ")}. The next response begins only after these tool results return.`;
	}
	if (scenario === "ask") {
		return "The question has closed. Inspect this continuation and the restored editor for missing rows or a blank band.";
	}
	if (scenario === "job") {
		return "Background waits have finished. Inspect the job cards and this continuation for missing rows or a blank band.";
	}
	return "All stages finished. Review the transcript, including code finalization, job-card contraction and the answered question.";
}

/** Scripted provider deltas decoded by agent-core, followed by real sandboxed tool execution. */
export function createRenderTestAgent(model: Model, options: RenderTestOptions, workflow: RenderWorkflow): Agent {
	validateRenderTestOptions(options);
	let outputRow = 0;
	let streamNumber = options.segment !== undefined ? options.segment - 1 : 0;
	return new Agent({
		initialState: { model, tools: workflow.tools, systemPrompt: [] },
		getToolContext: () => workflow.context,
		streamFn: (selectedModel, context, streamOptions) => {
			const stream = new AssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [],
				api: selectedModel.api,
				provider: selectedModel.provider,
				model: selectedModel.id,
				timestamp: Date.now(),
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const pause = async (ms: number): Promise<void> => {
				streamOptions?.signal?.throwIfAborted();
				await Bun.sleep(ms);
				streamOptions?.signal?.throwIfAborted();
			};
			const emitBlock = async (kind: "thinking" | "text", body: string): Promise<void> => {
				const contentIndex = message.content.length;
				const block =
					kind === "thinking" ? { type: "thinking" as const, thinking: "" } : { type: "text" as const, text: "" };
				message.content.push(block);
				stream.push({
					type: kind === "thinking" ? "thinking_start" : "text_start",
					contentIndex,
					partial: message,
				});
				for (let offset = 0; offset < body.length; offset += 48) {
					await pause(options.delayMs);
					const delta = body.slice(offset, offset + 48);
					if (block.type === "thinking") block.thinking += delta;
					else block.text += delta;
					stream.push({
						type: kind === "thinking" ? "thinking_delta" : "text_delta",
						contentIndex,
						delta,
						partial: message,
					});
				}
				stream.push({
					type: kind === "thinking" ? "thinking_end" : "text_end",
					contentIndex,
					content: body,
					partial: message,
				});
			};
			const produce = async (): Promise<void> => {
				const step = await workflow.next(context);
				const currentStream = ++streamNumber;
				const tools = step?.calls.map(call => call.name) ?? [];
				const introduction = step?.introduction === true && runsDefaultPass(options.scenario);
				const batch = batchTitle(tools, step !== undefined, introduction);
				// Separate provider responses from chunk pacing so tool results can settle visibly.
				await pause(300);
				stream.push({ type: "start", partial: message });
				const textParts: string[] = [];
				if (!step?.silent && !introduction) {
					textParts.push(
						`\n## Streaming ${currentStream} — BEGIN · ${step ? `Repetition ${step.repetition}` : "Summary"}\n\n**Batch: ${batch}.**\n\n`,
					);
				}
				if (options.scenario === "todo" && step?.introduction) {
					for (let row = 1; row <= 40; row++) {
						textParts.push(`TODO_CONTEXT_${row}: chat retained through TODO dismissal.\n\n`);
					}
				}
				if (options.scenario === "markdown") {
					// Fifty distinct lines make missing or duplicated rows visible during streaming.
					textParts.length = 0;
					textParts.push("# Streaming markdown fixture\n\n```text\n");
					for (let row = 1; row <= 50; row++) {
						textParts.push(`MARKDOWN_${String(row).padStart(2, "0")}: 0123456789012345678901234567890123456\n`);
					}
					textParts.push("```\n\n- Markdown only: no thinking blocks or prose filler.\n");
				} else if (introduction) {
					// One fenced Markdown code block of 60 rows — taller than the viewport,
					// so the stream has to move rows from the viewport into native history.
					const body = Array.from(
						{ length: 60 },
						(_, row) =>
							`CODE_${++outputRow}: context line ${row + 1} of 60 streamed into the viewport and history`,
					);
					textParts.push(`\`\`\`markdown\n${body.join("\n")}\n\`\`\`\n`);
				} else if (!step?.silent) {
					textParts.push(
						`STEP_${++outputRow}: ${stepDetail(tools, step !== undefined, currentStream, options.scenario)}\n`,
					);
				}
				if (!step?.silent && options.scenario !== "markdown" && options.scenario !== "advisor") {
					if (!introduction)
						textParts.push(
							`\n**Streaming ${currentStream} — END.** ${step ? "Tool results follow." : "No further responses in this workflow."}\n`,
						);
					await emitBlock("text", textParts.join(""));
				}
				if (options.scenario === "markdown") {
					const markdown = textParts.join("");
					for (let repetition = 0; repetition < options.repeat; repetition++) await emitBlock("text", markdown);
				}
				for (const call of step?.calls ?? []) {
					const contentIndex = message.content.length;
					message.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex, partial: message });
					const args = JSON.stringify(call.arguments);
					// Stream in a bounded number of deltas. A fixed 48-byte chunk turns a
					// ~36KB write payload into ~760 paced deltas (~19s at the default
					// delay), which looks exactly like the write card freezing.
					const chunk = Math.max(48, Math.ceil(args.length / MAX_TOOL_ARG_DELTAS));
					for (let offset = 0; offset < args.length; offset += chunk) {
						await pause(options.delayMs);
						stream.push({
							type: "toolcall_delta",
							contentIndex,
							delta: args.slice(offset, offset + chunk),
							partial: message,
						});
					}
					stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: message });
				}
				message.stopReason = step ? "toolUse" : "stop";
				stream.push({ type: "done", reason: message.stopReason, message });
				stream.end(message);
			};
			void produce().catch(error => {
				const reason = streamOptions?.signal?.aborted ? "aborted" : "error";
				message.stopReason = reason;
				message.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason, error: message });
				stream.end(message);
			});
			return stream;
		},
	});
}
