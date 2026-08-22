import * as fs from "node:fs";
import * as path from "node:path";
import { summarizeCode } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import type { EditMode } from "../utils/edit-mode";

const EDIT_BLACKBOX_FILE = "edit-blackbox.jsonl";

/** Full source transition committed by one edit operation. */
export interface AppliedEditSnapshot {
	/** Path used to select the tree-sitter language. */
	path: string;
	/** File content immediately before the operation. */
	prev: string;
	/** File content immediately after the operation. */
	next: string;
}

/** Observes a committed edit before its full-file snapshots are pruned. */
export type AppliedEditObserver = (snapshot: AppliedEditSnapshot) => Promise<void>;

function parses(code: string, filePath: string): boolean {
	// The structural summarizer treats an empty source as "not summarized",
	// while an empty source is valid in every supported tree-sitter language.
	const parseSource = code.length === 0 ? "\n" : code;
	return summarizeCode({ code: parseSource, path: filePath }).parsed;
}

/** Create the enabled per-tool-call observer that records newly introduced AST parse failures. */
export function createEditBlackboxObserver(
	session: ToolSession,
	variant: EditMode,
	arg: unknown,
): AppliedEditObserver | undefined {
	if (!session.settings.get("edit.blackbox.enabled")) return undefined;
	const logPath = path.join(session.settings.getAgentDir(), EDIT_BLACKBOX_FILE);
	const model = session.getActiveModelString?.() ?? "unknown";

	return async ({ path: filePath, prev, next }) => {
		try {
			// New content normally parses, so test it first and avoid re-parsing the
			// pre-image on the overwhelmingly common successful-edit path.
			if (parses(next, filePath) || !parses(prev, filePath)) return;
			await fs.promises.appendFile(logPath, `${JSON.stringify({ prev, new: next, model, variant, arg })}\n`);
		} catch (error) {
			// Recording is diagnostic only. The edit has already committed, so a
			// telemetry failure must not turn it into a reported edit failure.
			logger.debug("Failed to record edit parse regression", {
				path: logPath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
}
