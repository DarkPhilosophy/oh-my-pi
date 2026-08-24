/** Self-contained OSC 8 copy targets for fenced code blocks. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const COPY_URL_SCHEME = "omp-copy";

/** Whether this process can install a client-local custom URL handler. */
export function supportsCopyUrlHandler(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	xdgMime: string | null = Bun.which("xdg-mime"),
): boolean {
	return platform === "linux" && xdgMime !== null && !env.SSH_CLIENT && !env.SSH_CONNECTION && !env.SSH_TTY;
}

export function registerCopyBlock(code: string): string {
	const bytes = Buffer.from(code, "utf8");
	return `${COPY_URL_SCHEME}:${bytes.length}.${bytes.toString("base64url")}`;
}

let copyUrlHandlerReady = false;

/** Create a clickable target only after this process confirmed the local handler. */
export function copyUrlTarget(code: string, handlerReady = copyUrlHandlerReady): string | undefined {
	return handlerReady ? registerCopyBlock(code) : undefined;
}

export function resolveCopyBlock(arg: string): string | undefined {
	const raw = arg.startsWith(`${COPY_URL_SCHEME}:`) ? arg.slice(COPY_URL_SCHEME.length + 1) : arg;
	const payload = raw.replace(/\/+$/, "");
	const dot = payload.indexOf(".");
	if (dot <= 0) return undefined;
	const declaredLength = Number(payload.slice(0, dot));
	if (!Number.isInteger(declaredLength) || declaredLength <= 0) return undefined;
	const bytes = Buffer.from(payload.slice(dot + 1), "base64url");
	if (bytes.length !== declaredLength) return undefined;
	const decoded = bytes.toString("utf8");
	if (!Buffer.from(decoded, "utf8").equals(bytes)) return undefined;
	return decoded;
}

const COPY_DESKTOP_ENTRY = `${COPY_URL_SCHEME}.desktop`;
const COPY_SCHEME_MIME = `x-scheme-handler/${COPY_URL_SCHEME}`;

export interface CopyHandlerResult {
	ok: boolean;
	desktopPath: string;
	error?: string;
}

function resolveOmpBinary(): string {
	if (process.env.PI_COMPILED === "true") return process.execPath;
	return Bun.which("omp") ?? "omp";
}

function quoteDesktopExecArgument(value: string): string {
	const escaped = value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("`", "\\`")
		.replaceAll("$", "\\$")
		.replaceAll("%", "%%");
	return `"${escaped}"`;
}

export function createCopyDesktopEntry(binary: string): string {
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=OMP Copy",
		`Exec=${quoteDesktopExecArgument(binary)} copy %u`,
		"NoDisplay=true",
		"Terminal=false",
		`MimeType=${COPY_SCHEME_MIME};`,
		"",
	].join("\n");
}

export async function isCopyUrlHandlerRegistered(): Promise<boolean> {
	if (!supportsCopyUrlHandler()) return false;
	try {
		const proc = Bun.spawn(["xdg-mime", "query", "default", COPY_SCHEME_MIME], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = (await new Response(proc.stdout).text()).trim();
		await proc.exited;
		return out === COPY_DESKTOP_ENTRY;
	} catch {
		return false;
	}
}

export async function registerCopyUrlHandler(): Promise<CopyHandlerResult> {
	const appsDir = path.join(os.homedir(), ".local", "share", "applications");
	const desktopPath = path.join(appsDir, COPY_DESKTOP_ENTRY);
	if (!supportsCopyUrlHandler()) return { ok: false, desktopPath, error: "only supported on Linux (xdg)" };
	await fs.mkdir(appsDir, { recursive: true });
	const entry = createCopyDesktopEntry(resolveOmpBinary());
	await Bun.write(desktopPath, entry);
	const xdg = Bun.spawn(["xdg-mime", "default", COPY_DESKTOP_ENTRY, COPY_SCHEME_MIME], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const code = await xdg.exited;
	if (code !== 0) {
		const error = (await new Response(xdg.stderr).text()).trim();
		return {
			ok: false,
			desktopPath,
			error: error || `xdg-mime exited ${code}`,
		};
	}
	if (!(await isCopyUrlHandlerRegistered())) {
		return { ok: false, desktopPath, error: "xdg-mime did not activate the omp-copy handler" };
	}
	copyUrlHandlerReady = true;
	return { ok: true, desktopPath };
}

export async function ensureCopyUrlHandler(): Promise<boolean> {
	copyUrlHandlerReady = false;
	try {
		if (!supportsCopyUrlHandler()) return false;
		if (await isCopyUrlHandlerRegistered()) {
			copyUrlHandlerReady = true;
			return true;
		}
		const result = await registerCopyUrlHandler();
		return result.ok;
	} catch {
		// Best effort; `omp copy --install-handler` remains available.
		return false;
	}
}
