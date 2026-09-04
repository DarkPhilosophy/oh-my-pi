import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { COLLAB_GUEST_ALLOWED_COMMANDS } from "../collab/guest";
import type { DaemonConnectionSnapshot } from "../daemon/status";
import type { InteractiveModeContext } from "../modes/types";
import { BUILTIN_COLLABORATION_SLASH_COMMANDS } from "./builtin-collaboration";
import {
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
	buildMcpArgumentCompletions,
	buildModelSelectorCompletions,
	buildStaticInlineHint,
	buildSubcommandInlineHint,
} from "./builtin-completions";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "./builtin-control";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "./builtin-lifecycle";
import { BUILTIN_MARKETPLACE_SLASH_COMMANDS, reloadTuiPluginState } from "./builtin-marketplace";
import { BUILTIN_MODE_SLASH_COMMANDS } from "./builtin-modes";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "./builtin-session";
import { parseSlashCommand } from "./helpers/parse";
import { handleServerCommand } from "./helpers/server";
import type {
	BuiltinSlashCommand,
	BuiltinSlashCommandOwner,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export type {
	BuiltinSlashCommand,
	BuiltinSlashCommandOwner,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	SubcommandDef,
	TuiSlashCommandRuntime,
} from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

type InjectedServerControls = {
	snapshot?: DaemonConnectionSnapshot;
	getSnapshot?: () => DaemonConnectionSnapshot;
	sessions?: () => Promise<string> | string;
	reconnect?: () => Promise<void> | void;
	stop?: (
		force?: boolean,
	) =>
		| Promise<{ shutdown?: boolean; blockers?: string[] } | undefined>
		| { shutdown?: boolean; blockers?: string[] }
		| undefined;
	kill?: (
		force?: boolean,
	) =>
		| Promise<{ shutdown?: boolean; blockers?: string[] } | undefined>
		| { shutdown?: boolean; blockers?: string[] }
		| undefined;
	refresh?: (
		force?: boolean,
	) =>
		| Promise<{ shutdown?: boolean; blockers?: string[] } | undefined>
		| { shutdown?: boolean; blockers?: string[] }
		| undefined;
};

function injectedServerControls(ctx: InteractiveModeContext): InjectedServerControls | undefined {
	const candidate = ctx as InteractiveModeContext & {
		server?: InjectedServerControls;
		daemon?: InjectedServerControls;
	};
	return candidate.daemon ?? candidate.server;
}

const DAEMON_SLASH_COMMAND: SlashCommandSpec = {
	name: "daemon",
	aliases: ["server"],
	description: "Show daemon connection status and controls",
	inlineHint: "[status|sessions|reconnect|stop|kill|refresh] [--force]",
	allowArgs: true,
	subcommands: [
		{ name: "status", description: "Show daemon connection status" },
		{ name: "sessions", description: "List daemon sessions" },
		{ name: "reconnect", description: "Reconnect to the daemon" },
		{ name: "stop", description: "Stop the daemon gracefully" },
		{ name: "kill", description: "Stop the daemon immediately or safely" },
		{ name: "refresh", description: "Replace the daemon process" },
	],
	handleTui: async (command, runtime) => {
		runtime.ctx.editor.setText("");
		const controls = injectedServerControls(runtime.ctx);
		await handleServerCommand(command.args, {
			snapshot: controls?.getSnapshot?.() ?? controls?.snapshot ?? { state: "direct" },
			output: text => runtime.ctx.showStatus(text),
			sessions: controls?.sessions,
			reconnect: controls?.reconnect,
			stop: controls?.stop,
			kill: controls?.kill,
			refresh: controls?.refresh,
		});
	},
};

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	...BUILTIN_MODE_SLASH_COMMANDS,
	...BUILTIN_COLLABORATION_SLASH_COMMANDS,
	...BUILTIN_SESSION_SLASH_COMMANDS,
	DAEMON_SLASH_COMMAND,
	...BUILTIN_LIFECYCLE_SLASH_COMMANDS,
	...BUILTIN_MARKETPLACE_SLASH_COMMANDS,
	...BUILTIN_CONTROL_SLASH_COMMANDS,
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		description: command.description,
		owner: command.owner,
		icon: command.icon,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };
	if (cmd.subcommands) {
		materialized.getArgumentCompletions =
			cmd.name === "mcp" && runtime
				? buildMcpArgumentCompletions(cmd.subcommands, runtime)
				: buildArgumentCompletions(cmd.subcommands);
		materialized.getInlineHint = buildSubcommandInlineHint(cmd.subcommands);
	} else if (cmd.name === "move") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.name === "switch" && runtime) {
		materialized.getArgumentCompletions = buildModelSelectorCompletions(runtime);
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} is host-only during a collab session`);
		runtime.ctx.editor.setText("");
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: () => reloadTuiPluginState(ctx),
		};
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

/** Return the deterministic owner for a builtin in a daemon-attached TUI. */
export function getBuiltinSlashCommandOwnership(name: string): BuiltinSlashCommandOwner | undefined {
	const command = lookupBuiltinSlashCommand(name.trim().toLowerCase());
	if (!command) return undefined;
	return command.owner ?? (command.handle ? "daemon" : "client");
}
