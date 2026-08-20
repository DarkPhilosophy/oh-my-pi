import { runDaemonLifecycleAction } from "../commands/daemon";

export type DaemonLifecycleAction = "bgjob" | "kill" | "refresh";
export type DaemonShutdownMode = "graceful" | "force";
export type DaemonLifecycleRequest = Readonly<{
	action: DaemonLifecycleAction;
	mode: DaemonShutdownMode;
}>;

const DAEMON_ACTIONS: ReadonlySet<string> = new Set(["bgjob", "kill", "refresh"]);
const FORCE_WORDS: ReadonlySet<string> = new Set(["force", "--force"]);
const GRACEFUL_WORDS: ReadonlySet<string> = new Set(["graceful", "--graceful"]);

/**
 * Parse the root-level `--daemon <action> [force|graceful]` control surface.
 * Returning undefined means that `--daemon` is the normal interactive-mode
 * opt-in, not a lifecycle command.
 */
export function parseDaemonLifecycleArgv(
	argv: readonly string[],
): DaemonLifecycleRequest | { error: string } | undefined {
	const daemonIndex = argv.indexOf("--daemon");
	if (daemonIndex < 0) return undefined;
	const action = argv[daemonIndex + 1];
	if (action === undefined || !DAEMON_ACTIONS.has(action)) return undefined;
	if (action === "bgjob" && argv.length > daemonIndex + 2) {
		return { error: "Usage: omp --daemon bgjob" };
	}
	let mode: DaemonShutdownMode = "graceful";
	for (const word of argv.slice(daemonIndex + 2)) {
		if (FORCE_WORDS.has(word)) {
			if (mode === "graceful") mode = "force";
			else return { error: "Choose only one daemon shutdown mode: force or graceful" };
		} else if (GRACEFUL_WORDS.has(word)) {
			if (mode === "force") return { error: "Choose only one daemon shutdown mode: force or graceful" };
		} else {
			return { error: `Unknown daemon lifecycle argument: ${word}` };
		}
	}
	return { action: action as DaemonLifecycleAction, mode };
}
/** Execute a parsed root lifecycle request using the canonical daemon command implementation. */
export async function runDaemonLifecycle(request: DaemonLifecycleRequest): Promise<boolean> {
	return runDaemonLifecycleAction(request.action, request.mode === "force");
}
