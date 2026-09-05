/**
 * Manage the persistent daemon server for the active profile.
 *
 * The lifecycle actions are intentionally local and authenticated through the
 * daemon socket. `kill`/`refresh` default to a safe graceful check; `--force`
 * is the explicit operator decision that may interrupt working sessions.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getActiveProfile, getConfigRootDir, getProfileRootDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { createDaemonClient, type DaemonClient } from "../daemon/client";
import { startDaemonBackground } from "../daemon/interactive-bootstrap";
import { daemonRuntimeDir } from "../daemon/paths";
import type { DaemonOperation, DaemonServerStatus } from "../daemon/protocol";
import type { DaemonSessionDisplay } from "../daemon/status";
import { formatDaemonSessions } from "../daemon/session-display";
import { formatDaemonServerStatus } from "../daemon/status";

type DaemonAction = "status" | "sessions" | "reconnect" | "start" | "bgjob" | "kill" | "refresh" | "stop";
type ShutdownResult = { shutdown: boolean; blockers?: readonly string[] };

const JSON_ACTIONS: Record<DaemonAction, boolean> = {
	status: true,
	sessions: true,
	reconnect: false,
	start: false,
	bgjob: false,
	kill: false,
	refresh: false,
	stop: false,
};

export default class DaemonCommand extends Command {
	static description = "Manage the profile daemon (start, status, sessions, kill, refresh)";

	static args = {
		action: Args.string({
			description: "Operation (default: status)",
			required: false,
			options: ["status", "sessions", "reconnect", "start", "bgjob", "kill", "refresh", "stop"],
		}),
	};

	static flags = {
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON (status, sessions)", default: false }),
		force: Flags.boolean({ description: "Stop immediately, including working sessions", default: false }),
		graceful: Flags.boolean({ description: "Refuse while sessions are working (default)", default: false }),
	};

	static examples = [
		"# Start the detached daemon background job\n  omp --daemon start",
		"# `bgjob` is an explicit alias for start\n  omp --daemon bgjob",
		"# Inspect the active daemon\n  omp --daemon status",
		"# Safely stop after checking for working sessions\n  omp --daemon kill",
		"# Stop immediately (may interrupt work)\n  omp --daemon kill --force",
		"# Replace the daemon with a fresh background process\n  omp --daemon refresh",
		"# Replace it immediately\n  omp --daemon refresh --force",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(DaemonCommand);
		const action = (args.action ?? "status") as DaemonAction;
		if (flags.force && flags.graceful) {
			process.stderr.write("--force and --graceful are mutually exclusive\n");
			process.exitCode = 2;
			return;
		}
		if (flags.json && !JSON_ACTIONS[action]) {
			process.stderr.write(`--json is not supported for \`${action}\`\n`);
			process.exitCode = 1;
			return;
		}
		if (action === "start" || action === "bgjob") {
			await runStart();
			return;
		}
		if (action === "kill") {
			await runKillAll(flags.force === true);
			return;
		}

		const client = await createDaemonClient({ profile: getActiveProfile() ?? null });
		try {
			if (action === "refresh" || action === "stop") {
				await runLifecycle(client, action, flags.force === true);
			} else {
				await runQuery(client, action, flags.json);
			}
		} catch (error) {
			process.stderr.write(
				`daemon not reachable — ${error instanceof Error ? error.message : String(error)} (${client.endpoint})\n`,
			);
			process.exitCode = 1;
		} finally {
			client.close();
		}
	}
}

async function runStart(): Promise<void> {
	const status = await startDaemonBackground();
	process.stdout.write(`daemon background job ready (pid ${status.pid})\n`);
}

/** Execute `omp --daemon <action>` without going through the command parser. */
export async function runDaemonLifecycleAction(action: "bgjob" | "kill" | "refresh", force: boolean): Promise<boolean> {
	if (action === "bgjob") {
		await runStart();
		return true;
	}
	if (action === "kill") return runKillAll(force);
	const client = await createDaemonClient({ profile: getActiveProfile() ?? null });
	try {
		return await runLifecycle(client, "refresh", force);
	} finally {
		client.close();
	}
}

type DaemonTarget = { profile: string | null; runtimeDir: string };

/** Discover profile shards without touching their token files or spawning them. */
async function discoverDaemonTargets(): Promise<DaemonTarget[]> {
	const roots = new Map<string, string | null>();
	const baseRoot = getProfileRootDir(undefined);
	roots.set(baseRoot, null);
	roots.set(getConfigRootDir(), getActiveProfile() ?? null);
	try {
		const profilesRoot = path.join(baseRoot, "profiles");
		for (const entry of await fs.readdir(profilesRoot, { withFileTypes: true })) {
			if (entry.isDirectory()) roots.set(path.join(profilesRoot, entry.name), entry.name);
		}
	} catch {
		// The profiles directory is optional; the default shard is still checked.
	}
	const targets: DaemonTarget[] = [];
	for (const [root, profile] of roots) {
		const runtimeDir =
			root === getConfigRootDir() && profile === (getActiveProfile() ?? null)
				? daemonRuntimeDir()
				: path.join(root, "run", "daemon");
		if (
			(await Bun.file(path.join(runtimeDir, "daemon.owner")).exists()) ||
			(await Bun.file(path.join(runtimeDir, "daemon.sock")).exists())
		) {
			targets.push({ profile, runtimeDir });
		}
	}
	return targets;
}

async function runKillAll(force: boolean): Promise<boolean> {
	const targets = await discoverDaemonTargets();
	if (targets.length === 0) {
		process.stdout.write("no daemon instances found\n");
		return true;
	}
	let killed = 0;
	let failed = false;
	for (const target of targets) {
		const client = await createDaemonClient({ profile: target.profile, runtimeDir: target.runtimeDir });
		try {
			if (await runLifecycle(client, "kill", force)) killed++;
		} catch (error) {
			process.stderr.write(
				`daemon kill failed for ${target.profile ?? "default"}: ${error instanceof Error ? error.message : String(error)}\n`,
			);
			failed = true;
			process.exitCode = 1;
		} finally {
			client.close();
		}
	}
	if (killed > 0) process.stdout.write(`daemon kill requested for ${killed} instance${killed === 1 ? "" : "s"}\n`);
	return !failed && killed === targets.length;
}

async function waitForDaemonExit(runtimeDir: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		let pid: number | undefined;
		try {
			const owner = (await Bun.file(path.join(runtimeDir, "daemon.owner")).json()) as { pid?: unknown };
			if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) pid = owner.pid;
		} catch {
			return;
		}
		if (pid === undefined) return;
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		if (Date.now() >= deadline) return;
		await Bun.sleep(50);
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
	process.stdout.write(`${formatDaemonServerStatus(client.snapshot)}\n`);
}

/** Shared stop/kill/refresh lifecycle: preflight blockers, then a capability-gated shutdown. */
export async function runLifecycle(
	client: DaemonClient,
	action: "stop" | "kill" | "refresh",
	force: boolean,
): Promise<boolean> {
	await client.connect();
	const hasServerStatus = client.hasCapability("server_status");
	const status = hasServerStatus ? ((await client.serverStatus()) as DaemonServerStatus) : undefined;
	const sessions = hasServerStatus
		? ((await client.request("session_list")) as readonly DaemonSessionDisplay[])
		: undefined;
	if (!hasServerStatus) {
		process.stderr.write(
			`daemon ${action}: running daemon predates server-status inspection; blockers could not be inspected. Continuing shutdown.\n`,
		);
	}
	const working = sessions?.filter(session => session.isStreaming) ?? [];
	const protectedCount = status?.protectedJobCount ?? 0;
	if (hasServerStatus && !force && (working.length > 0 || protectedCount > 0)) {
		const details = [
			working.length > 0 ? `${working.length} working session${working.length === 1 ? "" : "s"}` : "",
			protectedCount > 0 ? `${protectedCount} protected job${protectedCount === 1 ? "" : "s"}` : "",
		]
			.filter(Boolean)
			.join(" and ");
		process.stderr.write(
			`daemon ${action} blocked: ${details} still active. Close the active sessions or repeat with --force.\n`,
		);
		process.exitCode = 1;
		return false;
	}
	const requestedForce = force && client.hasCapability("shutdown_force");
	if (force && !requestedForce) {
		process.stderr.write(
			`daemon ${action}: running daemon predates forced shutdown; sent graceful shutdown instead. Replace the daemon before retrying --force.\n`,
		);
	}
	const request: DaemonOperation = { op: "shutdown", ...(requestedForce ? { force: true } : {}) };
	const result = (await client.request(request)) as ShutdownResult;
	if (result.shutdown !== true) {
		const blockers = Array.isArray(result.blockers) ? result.blockers.join(", ") : "unknown blockers";
		process.stderr.write(`daemon ${action} blocked: ${blockers}\n`);
		process.exitCode = 1;
		return false;
	}
	if (action !== "refresh") {
		// Report what actually went over the wire: a capability downgrade turns a
		// requested --force into a graceful shutdown.
		process.stdout.write(
			`daemon ${action === "stop" ? "stopped" : "killed"}${requestedForce ? " forcefully" : " gracefully"}\n`,
		);
		return true;
	}
	const runtimeDir = client.runtimeDir;
	client.close();
	await waitForDaemonExit(runtimeDir);
	const fresh = await startDaemonBackground();
	process.stdout.write(`daemon refreshed (new pid ${fresh.pid})\n`);
	return true;
}
