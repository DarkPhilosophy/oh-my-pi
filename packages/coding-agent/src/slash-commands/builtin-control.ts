import { runPauseScreen } from "../modes/components/pause-screen";
import type { RenderTestOptions } from "../session/render-test";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

function parseRenderTestArgs(args: string): RenderTestOptions {
	const parts = args.trim().split(/\s+/);
	if ((parts[0] !== "test" && parts[0] !== "workflow") || parts.length > 3) {
		throw new Error("Usage: /render test|workflow [lines=100] [chunk-delay-ms=25]");
	}
	return { lines: Number(parts[1] ?? 100), delayMs: Number(parts[2] ?? 25), workflow: parts[0] === "workflow" };
}

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "render",
		description: "Stream local rendering test output without model requests or tokens",
		allowArgs: true,
		subcommands: [
			{ name: "test", description: "Simulate 100 numbered streaming lines", usage: "[lines] [chunk-delay-ms]" },
			{
				name: "workflow",
				description: "Run real TODO, read, edit and ask tools on disposable files",
				usage: "[lines] [chunk-delay-ms]",
			},
		],
		handle: async (command, runtime) => {
			const run = async (): Promise<void> => {
				try {
					await runtime.session.runRenderTest(parseRenderTestArgs(command.args));
				} catch (error) {
					await runtime.output(errorMessage(error));
				}
			};
			if (runtime.runCommandInBackground) {
				runtime.runCommandInBackground(run);
				return commandConsumed();
			}
			await run();
			return commandConsumed({ agentInvoked: true });
		},
		handleTui: async (command, { ctx }) => {
			ctx.editor.setText("");
			try {
				await ctx.session.runRenderTest(parseRenderTestArgs(command.args), ctx.getToolUIContext());
			} catch (error) {
				ctx.showError(errorMessage(error));
			}
		},
	},
	{
		name: "force",
		icon: "hammer",
		description: "Force next turn to use a specific tool",
		aliases: ["force:"],
		inlineHint: "<tool-name> [prompt]",
		allowArgs: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.getActiveToolNames().length;
			return count === 0 ? "Force: no active tools" : `Force: ${count} active tools`;
		},
		handle: async (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();
			if (!toolName) return usage("Usage: /force:<tool-name> [prompt]", runtime);
			try {
				runtime.session.setForcedToolChoice(toolName);
			} catch (err) {
				return usage(errorMessage(err), runtime);
			}
			await runtime.output(`Next turn forced to use ${toolName}.`);
			return prompt ? { prompt } : commandConsumed();
		},
		handleTui: (command, runtime) => {
			const spaceIdx = command.args.indexOf(" ");
			const toolName = spaceIdx === -1 ? command.args : command.args.slice(0, spaceIdx);
			const prompt = spaceIdx === -1 ? "" : command.args.slice(spaceIdx + 1).trim();

			if (!toolName) {
				runtime.ctx.showError("Usage: /force:<tool-name> [prompt]");
				runtime.ctx.editor.setText("");
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				runtime.ctx.editor.setText("");
				return;
			}

			runtime.ctx.editor.setText("");

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		icon: "voice",
		description: "Start Codex-backed realtime voice mode",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "pause",
		icon: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			runtime.ctx.editor.setText("");
			await runPauseScreen(runtime.ctx);
		},
	},
	{
		name: "quit",
		aliases: ["q"],
		icon: "power",
		description: "Quit the application",
		handleTui: shutdownHandlerTui,
	},
];
