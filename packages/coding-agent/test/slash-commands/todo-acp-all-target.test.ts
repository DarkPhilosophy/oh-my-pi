import { describe, expect, it } from "bun:test";
import { handleTodoAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/todo";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

// The headless dispatcher shares the user-facing `/todo` verbs with the TUI. A
// task whose text contains "all" is the trap: `all` must address the whole list
// instead of fuzzy-matching one task and reporting success.
function manyPhases(): TodoPhase[] {
	return Array.from({ length: 4 }, (_, i) => ({
		name: `Install all ${i + 1}`,
		tasks: [{ content: `Wire all ${i + 1}`, status: i < 3 ? ("completed" as const) : ("pending" as const) }],
	}));
}

function createRuntime(phases: TodoPhase[]) {
	const committed: TodoPhase[][] = [];
	const output: string[] = [];
	const runtime = {
		session: { getTodoPhases: () => phases, setTodoPhases: (next: TodoPhase[]) => committed.push(next) },
		sessionManager: { getBranch: () => [], appendCustomEntry: () => "entry", getCwd: () => "/" },
		cwd: "/",
		output: async (text: string) => {
			output.push(text);
		},
	} as unknown as SlashCommandRuntime;
	return { runtime, committed, output };
}

function command(args: string): ParsedSlashCommand {
	return { name: "todo", args, text: `/todo ${args}` };
}

describe("ACP /todo all target", () => {
	it("clears the whole list for rm all, even when tasks contain the word all", async () => {
		const { runtime, committed, output } = createRuntime(manyPhases());
		await handleTodoAcp(command("rm all"), runtime);
		expect(committed.at(-1)).toEqual([]);
		expect(output.at(-1)).toBe("Cleared all todos.");
	});

	it("treats ALL case-insensitively with surrounding whitespace", async () => {
		const { runtime, committed } = createRuntime(manyPhases());
		await handleTodoAcp(command("rm   ALL  "), runtime);
		expect(committed.at(-1)).toEqual([]);
	});

	it("completes every task for done all", async () => {
		const { runtime, committed, output } = createRuntime(manyPhases());
		await handleTodoAcp(command("done all"), runtime);
		expect(
			committed
				.at(-1)!
				.flatMap(phase => phase.tasks)
				.every(task => task.status === "completed"),
		).toBe(true);
		expect(output.at(-1)).toBe("Marked all tasks completed.");
	});

	it("abandons every task for drop all", async () => {
		const { runtime, committed } = createRuntime(manyPhases());
		await handleTodoAcp(command("drop all"), runtime);
		expect(
			committed
				.at(-1)!
				.flatMap(phase => phase.tasks)
				.every(task => task.status === "abandoned"),
		).toBe(true);
	});

	it("still targets one task when all is only part of a longer name", async () => {
		const { runtime, committed } = createRuntime(manyPhases());
		await handleTodoAcp(command("rm Wire all 4"), runtime);
		expect(
			committed
				.at(-1)!
				.flatMap(phase => phase.tasks)
				.map(task => task.content),
		).toEqual(["Wire all 1", "Wire all 2", "Wire all 3"]);
	});
});
