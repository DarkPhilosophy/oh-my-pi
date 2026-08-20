import { type DaemonConnectionSnapshot, formatDaemonServerStatus } from "../../daemon/status";
import { sanitizeStatusText } from "../../modes/shared";

export type ServerCommand = "status" | "sessions" | "reconnect" | "stop" | "kill" | "refresh";

export type ServerCommandOptions = {
	command: ServerCommand;
	force: boolean;
};

type ShutdownResult = { shutdown?: boolean; blockers?: string[] } | undefined;
type ShutdownCallback = (force?: boolean) => Promise<ShutdownResult> | ShutdownResult;

export interface ServerCommandCallbacks {
	snapshot: DaemonConnectionSnapshot;
	output: (text: string) => Promise<void> | void;
	sessions?: () => Promise<string> | string;
	reconnect?: () => Promise<void> | void;
	stop?: ShutdownCallback;
	kill?: ShutdownCallback;
	refresh?: ShutdownCallback;
}

/** Parse `/daemon` arguments, accepting one lifecycle flag. */
export function parseServerCommandOptions(args: string): ServerCommandOptions | null {
	const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (parts.length > 2) return null;
	const command = parts[0] ?? "status";
	if (!["status", "sessions", "reconnect", "stop", "kill", "refresh"].includes(command)) return null;
	const flag = parts[1];
	if (flag !== undefined && flag !== "--force" && flag !== "--graceful" && flag !== "force" && flag !== "graceful")
		return null;
	if (flag !== undefined && command !== "kill" && command !== "refresh" && command !== "stop") return null;
	return { command: command as ServerCommand, force: flag === "--force" || flag === "force" };
}

/** Backward-compatible command-only parser used by integrations and tests. */
export function parseServerCommand(args: string): ServerCommand | null {
	return parseServerCommandOptions(args)?.command ?? null;
}

/** Dispatch a daemon operation through injected callbacks and immutable state. */
export async function handleServerCommand(args: string, callbacks: ServerCommandCallbacks): Promise<void> {
	const parsed = parseServerCommandOptions(args);
	const command = parsed?.command;
	const force = parsed?.force === true;
	if (!command) {
		await callbacks.output("Usage: /daemon [status|sessions|reconnect|stop|kill|refresh] [--force|--graceful]");
		return;
	}
	if (command === "status") {
		await callbacks.output(formatDaemonServerStatus(callbacks.snapshot));
		return;
	}
	if (command === "sessions") {
		if (!callbacks.sessions) {
			await callbacks.output("daemon sessions unavailable");
			return;
		}
		const sessions = await callbacks.sessions();
		await callbacks.output(
			sessions
				.split(/\r?\n/)
				.map(line => sanitizeStatusText(line))
				.join("\n"),
		);
		return;
	}
	if (command === "reconnect") {
		if (!callbacks.reconnect) {
			await callbacks.output("daemon reconnect unavailable");
			return;
		}
		await callbacks.reconnect();
		await callbacks.output("daemon reconnect requested");
		return;
	}
	const callback = command === "kill" ? callbacks.kill : command === "refresh" ? callbacks.refresh : callbacks.stop;
	if (!callback) {
		await callbacks.output(`daemon ${command} unavailable`);
		return;
	}
	const result = await callback(force);
	if (result && result.shutdown === false) {
		const blockers = Array.isArray(result.blockers) ? result.blockers.map(String).join(", ") : "unknown blockers";
		await callbacks.output(`daemon ${command} blocked: ${sanitizeStatusText(blockers)}`);
		return;
	}
	await callbacks.output(`daemon ${command} requested${force ? " forcefully" : ""}`);
}
