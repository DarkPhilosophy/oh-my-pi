/** Self-contained OSC 8 copy targets for fenced code blocks. */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const COPY_URL_SCHEME = "omp-copy";

export function registerCopyBlock(code: string): string {
	const bytes = Buffer.from(code, "utf8");
	return `${COPY_URL_SCHEME}:${bytes.length}.${bytes.toString("base64url")}`;
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

export async function isCopyUrlHandlerRegistered(): Promise<boolean> {
	if (process.platform !== "linux") return false;
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
	if (process.platform !== "linux") return { ok: false, desktopPath, error: "only supported on Linux (xdg)" };
	await fsp.mkdir(appsDir, { recursive: true });
	const entry = [
		"[Desktop Entry]",
		"Type=Application",
		"Name=OMP Copy",
		`Exec=${resolveOmpBinary()} copy %u`,
		"NoDisplay=true",
		"Terminal=false",
		`MimeType=${COPY_SCHEME_MIME};`,
		"",
	].join("\n");
	await fsp.writeFile(desktopPath, entry, "utf8");
	const xdg = Bun.spawn(["xdg-mime", "default", COPY_DESKTOP_ENTRY, COPY_SCHEME_MIME], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const code = await xdg.exited;
	if (code !== 0) {
		const error = (await new Response(xdg.stderr).text()).trim();
		return { ok: false, desktopPath, error: error || `xdg-mime exited ${code}` };
	}
	return { ok: true, desktopPath };
}

export async function ensureCopyUrlHandler(): Promise<void> {
	try {
		if (process.platform !== "linux" || (await isCopyUrlHandlerRegistered())) return;
		await registerCopyUrlHandler();
	} catch {
		// Best effort; `omp copy --install-handler` remains available.
	}
}
