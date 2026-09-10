import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import type { RenderWorkflow } from "./render-workflow";

export interface RenderTestOptions {
	lines: number;
	/** Delay between simulated provider chunks, in milliseconds. */
	delayMs: number;
	workflow?: boolean;
}

/** Uses the normal agent-core stream decoder with a local scripted provider and optional real tools. */
export function createRenderTestAgent(model: Model, options: RenderTestOptions, workflow?: RenderWorkflow): Agent {
	if (!Number.isInteger(options.lines) || options.lines < 1 || options.lines > 1000) {
		throw new RangeError("Render test lines must be an integer between 1 and 1000.");
	}
	if (!Number.isInteger(options.delayMs) || options.delayMs < 1 || options.delayMs > 1000) {
		throw new RangeError("Render test delay must be an integer between 1 and 1000 ms.");
	}
	let outputRow = 0;
	return new Agent({
		initialState: { model, tools: workflow?.tools ?? [], systemPrompt: [] },
		getToolContext: () => workflow?.context,
		streamFn: (selectedModel, context, streamOptions) => {
			const stream = new AssistantMessageEventStream();
			const text = { type: "text" as const, text: "" };
			const message: AssistantMessage = {
				role: "assistant",
				content: [text],
				api: selectedModel.api,
				provider: selectedModel.provider,
				model: selectedModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			const produce = async (): Promise<void> => {
				const call = await workflow?.next(context);
				if (workflow) await Bun.sleep(Math.max(500, options.delayMs * 20));
				stream.push({ type: "start", partial: message });
				stream.push({ type: "text_start", contentIndex: 0, partial: message });
				const lines = workflow ? Math.min(options.lines, 8) : options.lines;
				for (let index = 0; index <= lines + 1; index++) {
					const line =
						index === 0
							? "```text\n"
							: index === lines + 1
								? "```\n"
								: `${index}. Render test message ${String(workflow ? ++outputRow : index).padStart(3, "0")} — continuous numbered model output.\n`;
					for (let offset = 0; offset < line.length; offset += 12) {
						await Bun.sleep(options.delayMs);
						if (streamOptions?.signal?.aborted) {
							message.stopReason = "aborted";
							message.errorMessage = "Render test interrupted";
							stream.push({ type: "error", reason: "aborted", error: message });
							stream.end(message);
							return;
						}
						const delta = line.slice(offset, offset + 12);
						text.text += delta;
						stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
					}
				}
				stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
				if (call) {
					message.content.push(call);
					stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
					stream.push({
						type: "toolcall_delta",
						contentIndex: 1,
						delta: JSON.stringify(call.arguments),
						partial: message,
					});
					stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: message });
					message.stopReason = "toolUse";
				}
				stream.push({ type: "done", reason: call ? "toolUse" : "stop", message });
				stream.end(message);
			};
			void produce().catch(error => {
				message.stopReason = "error";
				message.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: "error", error: message });
				stream.end(message);
			});
			return stream;
		},
	});
}
