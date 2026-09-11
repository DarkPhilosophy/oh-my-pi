import { runPauseScreen } from "../modes/components/pause-screen";
import type { RenderTestOptions } from "../session/render-test";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

function parseRenderTestArgs(args: string): RenderTestOptions {
	const parts = args.trim() ? args.trim().split(/\s+/) : [];
	let scenario: RenderTestOptions["scenario"];
	const positional: string[] = [];
	for (const part of parts) {
		if (part === "--ask" || part === "--job" || part === "--markdown") {
			if (scenario) throw new Error("Choose only one render scenario: --ask, --job or --markdown.");
			scenario = part.slice(2) as NonNullable<RenderTestOptions["scenario"]>;
		} else {
			positional.push(part);
		}
	}
	if (positional.length > 2 || positional.some(part => !/^\d+$/.test(part))) {
		throw new Error("Usage: /render [--ask|--job|--markdown] [repeat=1] [chunk-delay-ms=25]");
	}
	return { repeat: Number(positional[0] ?? 1), delayMs: Number(positional[1] ?? 25), scenario };
}

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "render",
		icon: "bug",
		description: "Exercise thinking, long text, Markdown, real reads/edits and interactive questions without tokens",
		allowArgs: true,
		inlineHint: "[--ask|--job|--markdown] [repeat=1] [chunk-delay-ms=25]",
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
