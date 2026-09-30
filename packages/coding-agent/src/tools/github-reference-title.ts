import * as path from "node:path";
import { DEFAULT_REPO_RESOLVED } from "./gh-common";
import { getCached, resolveGithubCacheAuthKey } from "./github-cache";
import type { GhIssueViewData } from "./gh-types";

/**
 * Title of a PR or issue that this machine has already fetched, or `undefined`.
 *
 * Runs on every frame the `#N` card is drawn, so it never leaves the process: the repository comes from the
 * memoised `gh repo view` result (empty until something has resolved it) and the title from the local view
 * cache. A cold cache is the normal case for a number that was never opened, not an error.
 */
export function lookupCachedReferenceTitle(cwd: string, kind: "pr" | "issue", number: string): string | undefined {
	const repo = DEFAULT_REPO_RESOLVED.get(path.resolve(cwd));
	if (repo === undefined) return undefined;
	const numeric = Number(number);
	if (!Number.isSafeInteger(numeric) || numeric < 1) return undefined;
	// The same local identity key gh-view stores under. Without one it bypasses the cache, and so do we: a view
	// cached for another account is never shown.
	const authKey = resolveGithubCacheAuthKey();
	if (authKey === undefined) return undefined;
	// A view fetched with comments sits in its own row; the title is the same in either.
	for (const includeComments of [false, true]) {
		const view = getCached<GhIssueViewData>(repo, kind, numeric, includeComments, authKey);
		const title = view?.payload.title?.trim();
		if (title) return title;
	}
	return undefined;
}
