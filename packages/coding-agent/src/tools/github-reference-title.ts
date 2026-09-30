import * as path from "node:path";
import { DEFAULT_REPO_RESOLVED, tryResolveCurrentRepo } from "./gh-common";
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

/** Checkouts whose repository lookup was already started, so a failure is not repeated on every frame. */
const attemptedCwds = new Set<string>();

/** Forget which checkouts were tried. Tests only. */
export function resetReferenceRepoAttempts(): void {
	attemptedCwds.clear();
}

/**
 * Make titles available for `cwd`: resolve its `owner/repo` in the background and call `onReady` only when that
 * newly made lookups possible. The card asks on every frame, so each checkout is tried once per process: the
 * shared resolver remembers successes but not failures, and a checkout without a GitHub remote (or with `gh`
 * signed out) would otherwise start a new `gh` process per frame. Never throws and never blocks the caller.
 */
export function warmReferenceRepo(cwd: string, onReady: () => void): void {
	const key = path.resolve(cwd);
	if (DEFAULT_REPO_RESOLVED.has(key) || attemptedCwds.has(key)) return;
	attemptedCwds.add(key);
	void tryResolveCurrentRepo(cwd, undefined).then(repo => {
		if (repo !== undefined) onReady();
	});
}
