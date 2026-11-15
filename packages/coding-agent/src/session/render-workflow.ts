import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Context, ToolCall } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AsyncJobManager } from "../async";
import { Settings } from "../config/settings";
import { EditTool } from "../edit";
import type { ToolSession } from "../tools";
import { AskTool } from "../tools/ask";
import { BashTool } from "../tools/bash";
import { WaitTool } from "../tools/wait";
import { EvalTool } from "../tools/eval";
import { ReadTool } from "../tools/read";
import { TodoTool } from "../tools/todo";
import { WriteTool } from "../tools/write";

/**
 * Named `/render` scenarios, in the order `/render` lists them. Each one is a fixed script of
 * provider responses run through the real tools; omitting the scenario runs the default
 * viewport → history pass, and `all` runs every scripted scenario end to end.
 */
export const RENDER_SCENARIOS = {
	all: "Every scenario below, end to end, after the default pass",
	edits: "Edit and write cards: a call followed by another call, one call over several files, consecutive calls, a stale-snapshot failure",
	"large-edit": "One wide multi-hunk edit taller than the viewport",
	"edit-error": "A tall edit preview that fails execution",
	eval: "Eval cards: a small cell, a 1200-line source, an oversized output",
	todo: "Todo list creation and completion",
	job: "A foreground handoff, ten concurrent background jobs and the waits that drain them",
	ask: "An interactive question that closes and resumes the stream",
	markdown: "Fifty streamed Markdown rows with no tool calls",
	advisor: "A display-only advisor card",
} as const;

export type RenderScenario = keyof typeof RENDER_SCENARIOS;

export function isRenderScenario(value: string): value is RenderScenario {
	return Object.hasOwn(RENDER_SCENARIOS, value);
}

export interface RenderWorkflowStep {
	silent?: boolean;
	calls: ToolCall[];
	repetition: number;
	introduction: boolean;
}

export interface RenderWorkflow {
	context: AgentToolContext;
	tools: Array<ReadTool | EditTool | TodoTool | AskTool | BashTool | WaitTool | WriteTool | EvalTool>;
	next(context: Context): Promise<RenderWorkflowStep | undefined>;
	dispose(): Promise<void>;
}

/** One scripted tool call; arguments resolve when its response is scripted, against the context so far. */
interface RenderAction {
	name: string;
	args: () => Record<string, unknown>;
}

/** The calls one scripted provider response makes. */
type RenderResponse = RenderAction[];

const FIXTURE_ROWS = [24, 64, 128] as const;
const TASKS = [
	"Read disposable workflow fixtures",
	"Edit disposable workflow fixtures",
	"Answer interactive workflow question",
];
const LARGE_WRITE_CONTENT =
	Array.from(
		{ length: 180 },
		(_, row) => `Generated write fixture row ${row + 1}: ${"content ".repeat(18)}for streaming card geometry.`,
	).join("\n") + "\n";
/** Scenarios `all` chains after the default pass; `ask` joins only when the host can show a form. */
const ALL_SCENARIOS: readonly RenderScenario[] = ["edits", "large-edit", "edit-error", "eval", "todo", "job", "ask"];

/** Real tools, restricted to owned disposable files; the provider only scripts their calls. */
export function createRenderWorkflow(
	session: ToolSession,
	context: AgentToolContext,
	repeat: number,
	scenario?: RenderScenario,
	segment?: number,
): RenderWorkflow {
	const canAsk = context.hasUI === true && context.ui?.formDialog !== undefined;
	if (scenario === "ask" && !canAsk) throw new Error("Render workflow requires interactive ask support.");
	const directory = TempDir.createSync(path.join(os.tmpdir(), "omp-render-workflow-"));
	const localSession: ToolSession = { ...session, cwd: directory.path(), hasEditTool: true };
	const jobs = new AsyncJobManager({ maxRunningJobs: 11 });
	const jobOwner = `render-workflow-${crypto.randomUUID()}`;
	const jobSession: ToolSession = {
		...localSession,
		asyncJobManager: jobs,
		getAgentId: () => jobOwner,
		settings: Settings.isolated({
			"bash.autoBackground.enabled": true,
			"bash.autoBackground.thresholdMs": 500,
		}),
	};
	const files = FIXTURE_ROWS.map((_, index) => `${directory.path()}/sample-${index + 1}.txt`);
	let currentContext: Context | undefined;
	let initialized = false;
	let stage = 0;
	let repetition = 1;

	// ── Actions ────────────────────────────────────────────────────────────
	const read = (index: number, rows: number = FIXTURE_ROWS[index]!): RenderAction => ({
		name: "read",
		args: () => ({ path: `${files[index]}:1-${rows}` }),
	});
	const readAll = (): RenderResponse => files.map((_, index) => read(index));
	/** Hashline snapshot tag of `file` from the newest read result the provider has seen. */
	const snapshotTag = (file: string): string => {
		const text = (currentContext?.messages ?? [])
			.flatMap(message =>
				message.role === "toolResult"
					? message.content.flatMap(block => (block.type === "text" ? [block.text] : []))
					: [],
			)
			.join("\n");
		const header = [...text.matchAll(/\[([^\]\n]+)#([0-9A-F]{4})\]/g)]
			.reverse()
			.find(match => match[1] === file || match[1] === path.basename(file));
		if (!header) throw new Error("Workflow read did not provide a snapshot for the edit.");
		return header[2]!;
	};
	/**
	 * One hashline edit call over `indices`. Wide edits touch rows 2, 64 and 120, so they fail
	 * on the 64-row fixture; a stale tag fails snapshot validation like an edit of old content.
	 */
	const edit = (indices: readonly number[], options: { wide?: boolean; staleTag?: boolean } = {}): RenderAction => ({
		name: "edit",
		args: () => {
			const sections = indices.map(index => {
				const file = files[index]!;
				const patch = options.wide
					? [2, 64, 120]
							.map(
								row => `PUT ${row}.=${row}:\n+Workflow repetition ${repetition}, wide multi-hunk edit ${row}.`,
							)
							.join("\n")
					: `PUT 2.=2:\n+Workflow repetition ${repetition}, response ${stage + 1}, edit ${index + 1} completed.`;
				return `[${file}#${options.staleTag ? "0000" : snapshotTag(file)}]\n${patch}`;
			});
			return { input: `*** Begin Patch\n${sections.join("\n")}\n*** End Patch\n` };
		},
	});
	const write = (target: string, content: string): RenderAction => ({
		name: "write",
		args: () => ({ path: target, content }),
	});
	const shortWrite = (index: number): RenderAction =>
		write(
			`${files[index]}.small`,
			Array.from({ length: 10 }, (_, row) => `SMALL_${index + 1}_${row + 1}: short streamed row`).join("\n"),
		);
	const bash = (command: string, timeout = 15, async = false): RenderAction => ({
		name: "bash",
		args: () => ({ command, timeout, ...(async ? { async: true } : {}) }),
	});
	const backgroundJob = (index: number, seconds: number): RenderAction =>
		bash(`sleep ${seconds} && printf 'Background job ${index + 1} completed\\n'`, seconds + 7, true);
	const wait = (): RenderAction => ({ name: "wait", args: () => ({}) });
	const todo = (args: Record<string, unknown>): RenderAction => ({ name: "todo", args: () => args });
	const evalCell = (title: string, code: string): RenderAction => ({
		name: "eval",
		args: () => ({ language: "js", title, code, timeout: 30 }),
	});
	const sourceRows = (count: number) => Array.from({ length: count }, (_, i) => `// SOURCE_${i + 1}`).join("\n");
	const longEval = evalCell(
		"Long eval",
		`${sourceRows(120)}\ndisplay(Array.from({ length: 80 }, (_, i) => \`OUTPUT_\${i + 1}\`))`,
	);
	const ask = (): RenderAction => ({
		name: "ask",
		args: () => ({
			html: [
				"<form>",
				"<fieldset>",
				`<legend>Repetition ${repetition}/${repeat}: continue after inspecting the rendering?</legend>`,
				'<label><input type="radio" name="render-workflow" value="continue" checked> Continue: Close the question and stream a short continuation.</label>',
				'<label><input type="radio" name="render-workflow" value="another"> Continue with another selection: Exercise a different selection before resuming.</label>',
				"</fieldset>",
				"</form>",
			].join("\n"),
		}),
	});

	// ── Scenarios ──────────────────────────────────────────────────────────
	/**
	 * Default pass: only what exercises viewport → history. Long-streaming cards taller than the
	 * viewport, the error edge cases, several cards streamed by one response, and short jobs.
	 */
	const defaultResponses = (): RenderResponse[] => [
		[todo({ op: "init", items: TASKS })],
		[write(files[2]!, LARGE_WRITE_CONTENT)],
		[read(1), read(2)],
		[edit([2], { wide: true })],
		[longEval],
		[edit([1], { wide: true })],
		// Writing onto the workflow directory itself fails in the write tool.
		[write(directory.path(), LARGE_WRITE_CONTENT)],
		[write(files[0]!, LARGE_WRITE_CONTENT), read(2, 180), edit([1]), longEval],
		// Three short writes in one response: every card stays mutable at once and none is clipped.
		[shortWrite(0), shortWrite(1), shortWrite(2)],
		[todo({ op: "done", task: TASKS[0] }), todo({ op: "done", task: TASKS[1] })],
		// Short background jobs: cards appear while running and retire when done.
		Array.from({ length: 4 }, (_, index) => backgroundJob(index, 2 + index)),
		[wait()],
		[todo({ op: "done", task: TASKS[2] })],
	];
	const scenarioResponses = (name: RenderScenario): RenderResponse[] => {
		switch (name) {
			case "all":
				return [
					...defaultResponses(),
					...ALL_SCENARIOS.filter(next => next !== "ask" || canAsk).flatMap(scenarioResponses),
				];
			case "edits":
				return [
					readAll(),
					// Its result must land on its own card, not arrive as a copy after the bash card.
					[edit([0]), bash("printf 'edit-then-bash\\n'")],
					readAll(),
					[edit([0, 1, 2])],
					readAll(),
					[edit([0]), edit([1]), edit([2])],
					[edit([1], { staleTag: true }), read(0)],
					[
						write(
							`${files[0]}.edits`,
							Array.from({ length: 6 }, (_, row) => `EDITS_WRITE_${row + 1}`).join("\n"),
						),
						bash("printf 'write-then-bash\\n'"),
					],
				];
			case "large-edit":
				return [[read(2)], [edit([2], { wide: true })]];
			case "edit-error":
				return [[read(1)], [edit([1], { wide: true })]];
			case "eval":
				return [
					[evalCell("Small eval", "display({ ok: true, rows: 3 })")],
					[evalCell("1200-line source", `${sourceRows(1200)}\ndisplay("source complete")`)],
					[evalCell("Oversized output", "display(Array.from({ length: 240 }, (_, i) => `OUTPUT_${i + 1}`))")],
				];
			case "todo":
				return [[todo({ op: "init", items: TASKS })], ...TASKS.map(task => [todo({ op: "done", task })])];
			case "job":
				// Background jobs outlive their launching response; each wait drains the next completion.
				// Long enough to overlap every launch and wait, short enough to stay a quick run.
				return [
					[bash("cat sample-1.txt && sleep 3")],
					Array.from({ length: 10 }, (_, index) => backgroundJob(index, 8)),
					...Array.from({ length: 4 }, () => [wait()]),
				];
			case "ask":
				return [[ask()]];
			case "markdown":
			case "advisor":
				// Driven by the scripted provider and the session: no tool calls.
				return [];
		}
	};

	const responses = scenario ? scenarioResponses(scenario) : defaultResponses();
	if (segment !== undefined) {
		if (segment < 1 || segment > responses.length) {
			throw new RangeError(`Render segment must be between 1 and ${responses.length}.`);
		}
		responses.splice(0, responses.length, responses[segment - 1]!);
	}
	const usesEval = !scenario || scenario === "eval" || scenario === "all";
	return {
		tools: [
			new ReadTool(localSession),
			new EditTool(localSession, "hashline"),
			new TodoTool(localSession),
			new WriteTool(localSession),
			new AskTool(localSession),
			new BashTool(jobSession),
			new WaitTool(jobSession),
			...(usesEval ? [new EvalTool(localSession)] : []),
		],
		context,
		async next(providerContext) {
			currentContext = providerContext;
			if (!initialized) {
				await Promise.all(
					files.map((file, index) =>
						Bun.write(
							file,
							Array.from({ length: FIXTURE_ROWS[index]! }, (_, row) => {
								const prefix = `Fixture ${index + 1}, row ${row + 1}: disposable rendering workflow content.`;
								if (index === 0) return prefix;
								return `${prefix} ${Array.from(
									{ length: index === 1 ? 4 : 24 },
									(_, column) => `cell-${row + 1}-${column + 1}=${(row + 1) * (column + 3)}`,
								).join(" | ")}`;
							}).join("\n") + "\n",
						),
					),
				);
				// An isolated segment runs without the earlier responses that created
				// the todo list, so seed it here; otherwise its `done` call fails.
				if (segment !== undefined) {
					localSession.setTodoPhases?.([
						{ name: "Tasks", tasks: TASKS.map(content => ({ content, status: "pending" })) },
					]);
				}
				initialized = true;
			}
			if (stage === responses.length) {
				if (repetition === repeat || scenario === "markdown") return undefined;
				repetition++;
				stage = 0;
			}
			const response = responses[stage]!;
			const introduction = stage === 0 && segment === undefined;
			const calls = response.map((action, offset): ToolCall => ({
				type: "toolCall",
				id: `render-workflow-${repetition}-${stage + 1}-${offset + 1}`,
				name: action.name,
				arguments: action.args(),
			}));
			stage += 1;
			return { calls, repetition, introduction, silent: calls.every(call => call.name === "wait") };
		},
		dispose: async () => {
			await jobs.dispose({ timeoutMs: 3_000 });
			await directory.remove();
		},
	};
}
