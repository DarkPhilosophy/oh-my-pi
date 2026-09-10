import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Context, ToolCall } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { EditTool } from "../edit";
import type { ToolSession } from "../tools";
import { AskTool } from "../tools/ask";
import { ReadTool } from "../tools/read";
import { TodoTool } from "../tools/todo";

export interface RenderWorkflowStep {
	calls: ToolCall[];
	repetition: number;
	introduction: boolean;
}

export interface RenderWorkflow {
	context: AgentToolContext;
	tools: Array<ReadTool | EditTool | TodoTool | AskTool>;
	next(context: Context): Promise<RenderWorkflowStep | undefined>;
	dispose(): Promise<void>;
}

/** Real tools, restricted to owned disposable files; the provider only scripts their calls. */
export function createRenderWorkflow(session: ToolSession, context: AgentToolContext, repeat: number): RenderWorkflow {
	if (!context.hasUI || !context.ui?.askDialog) throw new Error("Render workflow requires interactive ask support.");
	const directory = TempDir.createSync(path.join(os.tmpdir(), "omp-render-workflow-"));
	const localSession: ToolSession = { ...session, cwd: directory.path(), hasEditTool: true };
	const files = Array.from({ length: 3 }, (_, index) => directory.path() + `/sample-${index + 1}.txt`);
	let initialized = false;
	let stage = 0;
	let repetition = 1;
	const tasks = [
		"Read disposable workflow fixtures",
		"Edit disposable workflow fixtures",
		"Answer interactive workflow question",
	];
	const actions: Array<{ name: string; args: () => Record<string, unknown> }> = [];
	const read = (index: number) => actions.push({ name: "read", args: () => ({ path: files[index] + ":1-24" }) });
	let currentContext: Context;
	const edit = (index: number, invalid = false) =>
		actions.push({
			name: "edit",
			args: () => {
				const file = files[index]!;
				const text = currentContext.messages
					.flatMap(message =>
						message.role === "toolResult"
							? message.content.flatMap(block => (block.type === "text" ? [block.text] : []))
							: [],
					)
					.join("\n");
				const headers = [...text.matchAll(/\[([^\]\n]+)#([0-9A-F]{4})\]/g)];
				const header = headers.reverse().find(match => match[1] === file || match[1] === path.basename(file));
				if (!header) throw new Error("Workflow read did not provide a snapshot for the edit.");
				const tag = invalid ? (header[2] === "FFFF" ? "0000" : "FFFF") : header[2];
				return {
					input: `*** Begin Patch\n[${file}#${tag}]\nPUT 2.=2:\n+Workflow repetition ${repetition}, edit ${index + 1} completed.\n*** End Patch\n`,
				};
			},
		});
	actions.push({ name: "todo", args: () => ({ op: "init", items: tasks }) });
	read(0);
	read(1);
	read(2);
	edit(0);
	edit(1, true);
	edit(2);
	read(0);
	read(1);
	read(2);
	edit(1);
	actions.push({ name: "todo", args: () => ({ op: "done", task: tasks[0] }) });
	read(0);
	read(1);
	read(2);
	read(0);
	actions.push({ name: "todo", args: () => ({ op: "done", task: tasks[1] }) });
	actions.push({
		name: "ask",
		args: () => ({
			questions: [
				{
					id: "render-workflow",
					question: `Repetition ${repetition}/${repeat}: continue after inspecting the rendering?`,
					options: [
						{ label: "Continue", description: "Resume reads, edits and streamed output." },
						{
							label: "Continue with another selection",
							description: "Exercise a different selection before resuming.",
						},
					],
					recommended: 0,
				},
			],
		}),
	});
	actions.push({ name: "todo", args: () => ({ op: "done", task: tasks[2] }) });
	return {
		tools: [
			new ReadTool(localSession),
			new EditTool(localSession, "hashline"),
			new TodoTool(localSession),
			new AskTool(localSession),
		],
		context,
		async next(providerContext) {
			currentContext = providerContext;
			if (!initialized) {
				await Promise.all(
					files.map((file, index) =>
						Bun.write(
							file,
							Array.from(
								{ length: 24 },
								(_, row) => `Fixture ${index + 1}, row ${row + 1}: disposable rendering workflow content.`,
							).join("\n") + "\n",
						),
					),
				);
				initialized = true;
			}
			if (stage === actions.length) {
				if (repetition === repeat) return undefined;
				repetition++;
				stage = 0;
			}
			const introduction = stage === 0;
			const count = stage === 1 || stage === 4 ? 3 : 1;
			const calls = actions.slice(stage, stage + count).map((action, offset): ToolCall => ({
				type: "toolCall",
				id: `render-workflow-${repetition}-${stage + offset + 1}`,
				name: action.name,
				arguments: action.args(),
			}));
			stage += count;
			return { calls, repetition, introduction };
		},
		dispose: () => directory.remove(),
	};
}
