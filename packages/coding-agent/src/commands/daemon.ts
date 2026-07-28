/**
 * Manage the persistent daemon server for the active profile.
 *
 * Non-interactive wrapper around {@link DaemonClient}, mirroring the in-TUI
 * `/server` command so `omp daemon <status|sessions|reconnect|stop>` works from
 * scripts or another terminal. The CLI previously had no daemon command:
 * `omp daemon …` fell through to the interactive launch path (see
 * `isDefaultInteractiveArgv` in `daemon/interactive-route.ts`) and blocked on a
 * non-TTY because it tried to host an interactive session.
 */
import { getActiveProfile } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { createDaemonClient, type DaemonClient } from "../daemon/client";
import type { DaemonSessionDisplay } from "../daemon/status";
import { formatDaemonServerStatus, formatDaemonSessions } from "../daemon/status";

type DaemonAction = "status" | "sessions" | "reconnect" | "stop";

type ShutdownResult = { shutdown: boolean; blockers?: readonly string[] };

const JSON_ACTIONS: Record<DaemonAction, boolean> = {
	status: true,
	sessions: true,
	reconnect: false,
	stop: false,
};

export default class DaemonCommand extends Command {
	static description = "Manage the profile daemon server (status, sessions, reconnect, stop)";

	static args = {
		action: Args.string({
			description: "Operation to perform (default: status)",
			required: false,
			options: ["status", "sessions", "reconnect", "stop"],
		}),
	};

	static flags = {
		json: Flags.boolean({
			char: "j",
			description: "Emit machine-readable JSON (status, sessions)",
			default: false,
		}),
	};

	static examples = [
		"# Daemon connection + server status\n  omp daemon",
		"# Same, explicitly\n  omp daemon status",
		"# Active daemon sessions\n  omp daemon sessions",
		"# Re-establish a fresh client connection\n  omp daemon reconnect",
		"# Request a graceful daemon shutdown\n  omp daemon stop",
		"# Machine-readable status\n  omp daemon status --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(DaemonCommand);
		const action = (args.action ?? "status") as DaemonAction;
		if (flags.json && !JSON_ACTIONS[action]) {
			process.stderr.write(`--json is not supported for \`${action}\`\n`);
			process.exitCode = 1;
			return;
		}
		const client = await createDaemonClient({ profile: getActiveProfile() ?? null });
		try {
			if (action === "stop") await runStop(client);
			else await runQuery(client, action, flags.json);
		} catch (error) {
			process.stderr.write(
				`daemon not reachable — ${error instanceof Error ? error.message : String(error)} (${client.endpoint})\n`,
			);
			process.exitCode = 1;
		} finally {
			// The client owns a socket + heartbeat interval; closing it is the only
			// way the process can exit after a one-shot query.
			client.close();
		}
	}
}

async function runQuery(
	client: DaemonClient,
	action: "status" | "sessions" | "reconnect",
	json: boolean,
): Promise<void> {
	await client.connect();
	if (action === "sessions") {
		const sessions = (await client.request("session_list")) as readonly DaemonSessionDisplay[];
		process.stdout.write(`${json ? JSON.stringify(sessions, null, 2) : formatDaemonSessions(sessions)}\n`);
		return;
	}
	if (json) {
		process.stdout.write(`${JSON.stringify(client.snapshot, null, 2)}\n`);
		return;
	}
	// status and reconnect both establish a live connection and report it. A
	// one-shot client has no prior socket to drop, so reconnect degrades to a
	// fresh connection probe that prints the same live snapshot.
	process.stdout.write(`${formatDaemonServerStatus(client.snapshot)}\n`);
}

async function runStop(client: DaemonClient): Promise<void> {
	await client.connect();
	const result = (await client.request("shutdown")) as ShutdownResult;
	if (result.shutdown === false) {
		const blockers = Array.isArray(result.blockers) ? result.blockers.join(", ") : "unknown blockers";
		process.stderr.write(`daemon stop blocked: ${blockers}\n`);
		process.exitCode = 1;
		return;
	}
	process.stdout.write("daemon stop requested\n");
}
