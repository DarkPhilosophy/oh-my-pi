/**
 * Canonical user-facing status line for session lifecycle actions so every
 * surface (direct-mode startup, daemon-hosted TUI, `--resume`, `--fork`,
 * `/resume`, `/fork`, `/move`, RPC slash commands) prints the exact same text.
 * The short id keeps the line scannable while remaining unambiguous for
 * `--resume <id>`.
 */
export function sessionActionMessage(
	action: "resumed" | "forked" | "moved",
	sessionId: string | undefined,
	cwd: string,
): string {
	const shortId = sessionId && sessionId.length >= 8 ? sessionId.slice(0, 8) : (sessionId ?? "unknown");
	return `Session ${shortId} ${action} in ${cwd}`;
}
