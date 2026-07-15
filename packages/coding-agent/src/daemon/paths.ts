import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir } from "@oh-my-pi/pi-utils";
import type { DaemonShard } from "./protocol";

export const DAEMON_TOKEN_FILE = "daemon.token";
export const DAEMON_SOCKET_FILE = "daemon.sock";

/** Resolve a project root through symlinks when it exists. */
export async function canonicalProjectRoot(projectRoot: string): Promise<string> {
	const resolved = path.resolve(projectRoot);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return resolved;
		throw error;
	}
}

/** Canonical identity used to select one profile/project daemon shard. */
export async function daemonShard(profile: string, projectRoot: string): Promise<DaemonShard> {
	if (!profile) throw new Error("Daemon profile must not be empty");
	return { profile, projectRoot: await canonicalProjectRoot(projectRoot) };
}

/** Return true when cwd is the canonical root or one of its descendants. */
export function isDaemonPathInScope(projectRoot: string, cwd: string): boolean {
	const root = path.resolve(projectRoot);
	const candidate = path.resolve(cwd);
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

/** Resolve the private runtime directory for one profile/project shard. */
export function daemonRuntimeDir(
	profile: string,
	projectRoot: string,
	configRoot: string = getConfigRootDir(),
): string {
	const identity = `${profile}\0${path.resolve(projectRoot)}`;
	const key = Bun.hash.wyhash(identity).toString(16).padStart(16, "0");
	return path.join(configRoot, "run", "daemons", key);
}

/** Resolve runtime directory from an already canonical shard. */
export function daemonRuntimeDirForShard(shard: DaemonShard, configRoot: string = getConfigRootDir()): string {
	return daemonRuntimeDir(shard.profile, shard.projectRoot, configRoot);
}

/** Resolve the Unix socket endpoint for a shard runtime directory. */
export function daemonEndpoint(runtimeDir: string): string {
	return path.join(runtimeDir, DAEMON_SOCKET_FILE);
}

/** Ensure the runtime directory is private to the current user. */
export async function ensureDaemonRuntimeDir(runtimeDir: string): Promise<void> {
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	await fs.chmod(runtimeDir, 0o700);
}

/** Return the token path for a runtime directory. */
export function daemonTokenPath(runtimeDir: string): string {
	return path.join(runtimeDir, DAEMON_TOKEN_FILE);
}

/** Read an existing token or atomically create a private cryptographic token. */
export async function readOrCreateDaemonToken(runtimeDir: string): Promise<string> {
	await ensureDaemonRuntimeDir(runtimeDir);
	const tokenPath = daemonTokenPath(runtimeDir);
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const token = (await Bun.file(tokenPath).text()).trim();
			if (token.length > 0) {
				await fs.chmod(tokenPath, 0o600);
				return token;
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		try {
			const handle = await fs.open(tokenPath, "wx", 0o600);
			try {
				const token = `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
				await handle.writeFile(token, "utf8");
				return token;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		await Bun.sleep(1);
	}
	throw new Error(`Timed out initializing daemon token in ${runtimeDir}`);
}
