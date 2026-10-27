import { type PauseWorkStatus, runPauseScreen } from "@oh-my-pi/pi-tui/overlays/pause-screen";
import { AgentRegistry } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { RenderTestOptions } from "../session/render-test";
import { clearApprovalGrants } from "../tools/approval-cache";
import { clearSubmittedText } from "./helpers/draft";
import { shutdownHandlerTui } from "./builtin-lifecycle";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

function parseRenderTestArgs(args: string): RenderTestOptions {
	const parts = args.trim() ? args.trim().split(/\s+/) : [];
	let scenario: RenderTestOptions["scenario"];
	let segment: number | undefined;
	const positional: string[] = [];
	for (const part of parts) {
		if (
			["--ask", "--job", "--markdown", "--todo", "--large-edit", "--edit-error", "--advisor", "--eval"].includes(
				part,
			)
		) {
			if (scenario) throw new Error("Choose only one render scenario.");
			scenario = part.slice(2) as NonNullable<RenderTestOptions["scenario"]>;
		} else if (part.startsWith("--segment")) {
			const value = part.includes("=") ? part.slice(part.indexOf("=") + 1) : "";
			if (!/^\d+$/.test(value)) throw new Error("Usage: --segment=<n> selects a single scripted response.");
			segment = Number(value);
		} else {
			positional.push(part);
		}
	}
	if (positional.length > 2 || positional.some(part => !/^\d+$/.test(part))) {
		throw new Error(
			"Usage: /render [--ask|--job|--markdown|--todo|--large-edit|--edit-error|--advisor|--eval] [--segment=<n>] [repeat=1] [chunk-delay-ms=25]",
		);
	}
	return { repeat: Number(positional[0] ?? 1), delayMs: Number(positional[1] ?? 25), scenario, segment };
}

/** Advisors with review work they can still run (not parked, yielded, or quota-paused). */
function advisorUnsettledCount(session: AgentSession): number {
	return session
		.getAdvisorStatusOverview()
		.advisors.filter(advisor => advisor.backlog > 0 && !advisor.isPaused && !advisor.yielded).length;
}

/**
 * Outstanding work for the `/pause` screen. A subagent counts as a turn only
 * while its session streams and is not parked; its task job is deduplicated
 * against that same live set, so a pre-live or stale `running` ref still
 * counts through its job. Advisors of the root and every live subagent count.
 */
function pauseWorkStatus(root: AgentSession): PauseWorkStatus {
	const registry = AgentRegistry.global();
	const liveSubagents = registry.list().filter(ref => ref.kind === "sub" && registry.isRunning(ref));
	const liveSubagentIds = new Set(liveSubagents.map(ref => ref.id));
	let unsettledTurns = Number(root.isStreaming && !root.agent.isPaused) + advisorUnsettledCount(root);
	for (const ref of liveSubagents) {
		if (!ref.session) continue;
		if (!ref.session.agent.isPaused) unsettledTurns++;
		unsettledTurns += advisorUnsettledCount(ref.session);
	}
	const unfinishedJobs =
		root
			.getAsyncJobTree({ recentLimit: 0 })
			?.running.filter(job => job.type !== "task" || job.agentId === undefined || !liveSubagentIds.has(job.agentId))
			.length ?? 0;
	return { unsettledTurns, unfinishedJobs };
}

export const BUILTIN_CONTROL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "render",
		icon: "bug",
		description:
			"Exercise streaming Markdown, large edits, edit failures, advisor display, and interactive cards without tokens",
		allowArgs: true,
		inlineHint:
			"[--ask|--job|--markdown|--todo|--large-edit|--edit-error|--advisor|--eval] [--segment=<n>] [repeat=1] [chunk-delay-ms=25]",
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
				clearSubmittedText(runtime);
				return;
			}

			try {
				runtime.ctx.session.setForcedToolChoice(toolName);
				runtime.ctx.showStatus(`Next turn forced to use ${toolName}.`);
			} catch (error) {
				runtime.ctx.showError(errorMessage(error));
				clearSubmittedText(runtime);
				return;
			}

			clearSubmittedText(runtime);

			// If a prompt was provided, pass it through as input
			if (prompt) return { prompt };
		},
	},
	{
		name: "live",
		icon: "voice",
		description: "Start Codex-backed realtime voice mode",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.handleLiveCommand();
		},
	},
	{
		name: "record",
		icon: "export",
		description: "Start or stop recording this screen to a replayable file (omp play)",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			await runtime.ctx.toggleRecording();
		},
	},
	{
		name: "pause",
		icon: "pause",
		description: "Freeze all agents (main, subagents, advisor) until resumed",
		handleTui: async (_command, runtime) => {
			clearSubmittedText(runtime);
			const ctx = runtime.ctx;
			await runPauseScreen(ctx, { getWorkStatus: () => pauseWorkStatus(ctx.session) });
		},
	},
	{
		name: "forget-approvals",
		icon: "trash",
		description: "Forget every file and folder approval Ask and remember has recorded",
		handle: async (_command, runtime) => {
			clearApprovalGrants(runtime.settings.getAgentDir());
			await runtime.output("Remembered approvals forgotten; the next read or write asks again.");
			return commandConsumed();
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
