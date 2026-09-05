import { sanitizeStatusText } from "../modes/shared";
import { shortenPath } from "../tools/render-utils";
import type { DaemonSessionDisplay } from "./status";

/** Session inventory rendering is runtime-only, unlike the lightweight prepaint status. */
export function formatDaemonSessions(sessions: readonly DaemonSessionDisplay[]): string {
	if (sessions.length === 0) return "No daemon sessions";
	const lines = [`${sessions.length} daemon session${sessions.length === 1 ? "" : "s"}`];
	for (const session of sessions) {
		const activity = session.isStreaming
			? "streaming"
			: session.interactiveAttached
				? "interactive"
				: session.attachmentCount > 0
					? "attached"
					: "parked";
		const attachments = `${session.attachmentCount} attachment${session.attachmentCount === 1 ? "" : "s"}`;
		lines.push(
			"",
			`● ${sanitizeStatusText(String(session.sessionId ?? ""))}  ${activity}`,
			`  cwd: ${sanitizeStatusText(shortenPath(session.cwd))}`,
			`  ${attachments} · interactive: ${session.interactiveAttached ? "yes" : "no"} · streaming: ${session.isStreaming ? "yes" : "no"}`,
		);
	}
	return lines.join("\n");
}
