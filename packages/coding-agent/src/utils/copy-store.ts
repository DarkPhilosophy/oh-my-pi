/**
 * Self-contained copy targets for fenced code blocks.
 *
 * The transcript renders each code block's `[copy]` chip as an OSC 8 hyperlink
 * whose target is `omp-copy:<base64url>` — the block's UTF-8 bytes encoded
 * directly into the URL. Clicking it makes the terminal open that URL through
 * the OS, which launches `omp copy <url>` — a short-lived process that decodes
 * the payload and places it on the system clipboard via the native (arboard)
 * path. This copies with a real mouse click WITHOUT enabling main-screen mouse
 * tracking, and WITHOUT persisting anything to disk: the code travels in the
 * URL itself, so the running session and the launched `omp copy` process need
 * no shared store or IPC.
 */
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** Custom URL scheme handled by `omp copy`. */
export const COPY_URL_SCHEME = "omp-copy";

/** Encode a code block into a self-contained `omp-copy:<len>.<base64url>` target. */
export function registerCopyBlock(code: string): string {
	const bytes = Buffer.from(code, "utf8");
	return `${COPY_URL_SCHEME}:${bytes.length}.${bytes.toString("base64url")}`;
}

/**
 * Resolve code from a full `omp-copy:<len>.<base64url>` URL (or a bare payload).
 * `<len>` is the block's UTF-8 byte count; a mismatch after decoding means the
 * URL was truncated (e.g. by a terminal's OSC 8 length limit), tampered, or is a
 * legacy/foreign target — so we fail cleanly with undefined instead of copying
 * partial or garbage content.
 */
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
	// Reject non-UTF8: a lossy decode would not re-encode to the same bytes.
	if (!Buffer.from(decoded, "utf8").equals(bytes)) return undefined;
	return decoded;
}

// ---------------------------------------------------------------------------
// OS URL-scheme handler for `omp-copy:` (Linux/xdg)
//
// Clicking a code-block `[copy]` chip makes the terminal open `omp-copy:<id>`,
// which the OS routes to `omp copy <url>`. That requires a one-time desktop
// entry + scheme association. Registration is idempotent and additive: it only
// ever claims our own `x-scheme-handler/omp-copy`, never another app's scheme.
// ---------------------------------------------------------------------------

/** Desktop entry filename for the copy URL handler. */
const COPY_DESKTOP_ENTRY = `${COPY_URL_SCHEME}.desktop`;
/** MIME type naming the omp-copy: URL scheme. */
const COPY_SCHEME_MIME = `x-scheme-handler/${COPY_URL_SCHEME}`;

/** Result of a handler-registration attempt. */
export interface CopyHandlerResult {
	ok: boolean;
	desktopPath: string;
	error?: string;
}

/** Resolve the omp binary the URL handler should invoke. */
function resolveOmpBinary(): string {
	if (process.env.PI_COMPILED === "true") return process.execPath;
	return Bun.which("omp") ?? "omp";
}

/** True when `omp-copy:` already resolves to our desktop entry (Linux only). */
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

/**
 * Register the `omp-copy:` URL scheme (Linux/xdg): write the desktop entry and
 * point the scheme handler at it. Idempotent — safe to call repeatedly.
 */
export async function registerCopyUrlHandler(): Promise<CopyHandlerResult> {
	const appsDir = path.join(os.homedir(), ".local", "share", "applications");
	const desktopPath = path.join(appsDir, COPY_DESKTOP_ENTRY);
	if (process.platform !== "linux") {
		return { ok: false, desktopPath, error: "only supported on Linux (xdg)" };
	}
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
	try {
		await Bun.spawn(["update-desktop-database", appsDir], { stdout: "ignore", stderr: "ignore" }).exited;
	} catch {
		// update-desktop-database is optional
	}
	if (code !== 0) {
		const err = (await new Response(xdg.stderr).text()).trim();
		return { ok: false, desktopPath, error: err || `xdg-mime exited ${code}` };
	}
	return { ok: true, desktopPath };
}

/**
 * Best-effort auto-registration: register the handler once if it is not already
 * present. Never throws and never clobbers an existing registration, so startup
 * can call it fire-and-forget without forcing anything on the user.
 */
export async function ensureCopyUrlHandler(): Promise<void> {
	try {
		if (process.platform !== "linux") return;
		if (await isCopyUrlHandlerRegistered()) return;
		await registerCopyUrlHandler();
	} catch {
		// best-effort; the manual `omp copy --install-handler` remains available
	}
}
