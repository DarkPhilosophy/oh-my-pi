import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { RenderWorkflow } from "./render-workflow";

export interface RenderTestOptions {
	repeat: number;
	/** Delay between simulated provider chunks, in milliseconds. */
	delayMs: number;
	scenario?: "ask" | "job" | "markdown" | "todo";
	/** Isolate a single scripted response (1-based); labels keep the original number. */
	segment?: number;
}

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
				const batch =
					step?.introduction && !options.scenario
						? "Analysis, long-form text and one viewport-spanning code block"
						: tools.includes("ask")
							? "Interactive question — draft input, submission and dialog restoration"
							: tools.includes("edit")
								? "File changes — real snapshot validation and edit results"
								: tools.includes("read")
									? "File inspection — read the current contents before the next change"
									: tools.includes("bash")
										? "Background processing — foreground handoff and concurrent jobs"
										: step
											? "Workflow progress"
											: "Completed workflow";
				// Separate provider responses from chunk pacing so tool results can settle visibly.
				await pause(1500 + ((currentStream - 1) % 3) * 250);
				stream.push({ type: "start", partial: message });
				if (step?.introduction && !options.scenario) {
					await emitBlock(
						"thinking",
						`Streaming ${currentStream} — synthetic planning for repetition ${step.repetition}.\n` +
							"Inspect three disposable files, attempt three edits together, then reread before retrying the deliberately stale edit. " +
							"Keep background waits consecutive. Finish with a real question to exercise draft input and restoration.\n",
					);
				}
				const textParts: string[] = [];
				if (!step?.silent) {
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
					textParts.push("```text\n");
					for (let row = 1; row <= 50; row++) {
						textParts.push(`MARKDOWN_${String(row).padStart(2, "0")}: 0123456789012345678901234567890123456\n`);
					}
					textParts.push("```");
				} else if (step?.introduction && !options.scenario) {
					const operations = [
						[
							"Initial inspection",
							"Read the three disposable files",
							"Each read returns the current snapshot",
							"No project files are changed",
							"The next response may use those snapshots",
							"The read cards should remain in order",
						],
						[
							"Grouped edits",
							"Submit three edits in one response",
							"The middle edit uses a deliberately stale hash",
							"The other two edits use valid snapshots",
							"An error card is expected, not a renderer failure",
							"The next response must inspect the failed file",
						],
						[
							"Recovery",
							"Read the file whose edit failed",
							"Use the newly returned snapshot for the retry",
							"Do not guess the replacement hash",
							"The retry changes only the disposable fixture",
							"The successful result should follow its read",
						],
						[
							"Result inspection",
							"Read the files after the edits",
							"Compare their updated second lines",
							"Keep long read previews separate from assistant prose",
							"Tool results are not separate model responses",
							"Their cards may change height when finalized",
						],
						[
							"Foreground work",
							"Start a command that prints before waiting",
							"Its initial output occupies a live card",
							"The command crosses the background threshold",
							"The card changes while the process continues",
							"Earlier transcript rows must remain recoverable",
						],
						[
							"Concurrent work",
							"Start ten additional finite background jobs",
							"Each job has its own identifier",
							"Completion order need not match launch order",
							"All jobs run inside the disposable workflow",
							"No network provider is involved",
						],
						[
							"Waiting",
							"Issue four consecutive wait responses",
							"Those responses intentionally contain no assistant prose",
							"A new wait may replace the preceding waiting card",
							"The visible stream numbering therefore skips those responses",
							"Inserting a heading there would change the reproduction",
						],
						[
							"Question",
							"Open an actual interactive ask dialog",
							"Execution pauses until an answer or cancellation",
							"A draft can coexist with the question",
							"Submitting or clearing the draft changes the editor height",
							"Closing the question must not leave a blank band",
						],
						[
							"Continuation",
							"Resume after the selected answer",
							"Finish the workflow progress state",
							"Restore the original task list",
							"Dispose the sandbox and its background jobs",
							"The next repetition starts a fresh sequence of responses",
						],
						[
							"Finalization",
							"The following code is one continuous sixty-line block",
							"It is streamed in chunks, not appended as sixty messages",
							"The closing fence arrives after the entire body",
							"Line numbers and borders must remain consistent",
							"Check the complete transcript for gaps and duplicates",
						],
					];
					textParts.push(
						operations
							.map(lines => lines.map(line => `PLAIN_${++outputRow}: ${line}.  \n`).join("") + "\n")
							.join(""),
					);
					const code = operations
						.concat([
							[
								"Viewport",
								"Preserve the bottom editor anchor",
								"Keep live rows ordered",
								"Allow temporary coverage",
								"Restore covered rows",
								"Do not duplicate scrollback",
							],
							[
								"Audit",
								"Count emitted markers",
								"Compare complete terminal output",
								"Check first and last code borders",
								"Check the question transition",
								"Report only exercised behavior",
							],
						])
						.flatMap((lines, index) => [
							`function inspectStage${index + 1}(observed: string[]): boolean {`,
							`  // ${lines[0]}: ${lines[1]}.`,
							`  const expected = ${JSON.stringify(lines.slice(2))};`,
							"  return expected.every(item => observed.includes(item));",
							"}",
						]);
					textParts.push(
						"\n```typescript\n" + code.map(line => `${line} // CODE_${++outputRow}\n`).join("") + "```\n",
					);
				} else if (!step?.silent) {
					const detail = tools.includes("ask")
						? "The next tool opens the question. Try draft input and submission before answering; the workflow then resumes."
						: tools.includes("edit") && tools.length === 3
							? "Three edits belong to this one response. The second deliberately fails hash validation; recovery happens in a later response."
							: tools.includes("bash") && tools.length === 10
								? `Ten jobs launch in this batch. Streaming ${currentStream + 1}–${currentStream + 4} are tool-only wait responses, with no narration between them.`
								: step
									? `This response calls: ${tools.join(" → ")}. The next response begins only after these tool results return.`
									: options.scenario === "ask"
										? "The question has closed. Inspect this continuation and the restored editor for missing rows or a blank band."
										: options.scenario === "job"
											? "Background waits have finished. Inspect the job cards and this continuation for missing rows or a blank band."
											: "All stages finished. Review the transcript, including code finalization, job-card contraction and the answered question.";
					textParts.push(`STEP_${++outputRow}: ${detail}\n`);
				}
				if (!step?.silent && options.scenario !== "markdown") {
					textParts.push(
						`\n**Streaming ${currentStream} — END.** ${step ? "Tool results follow; the next response starts after a 1.5–2 second pause." : "No further responses in this workflow."}\n`,
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
					for (let offset = 0; offset < args.length; offset += 48) {
						await pause(options.delayMs);
						stream.push({
							type: "toolcall_delta",
							contentIndex,
							delta: args.slice(offset, offset + 48),
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
