/**
 * `lookupCachedReferenceTitle` feeds the caption of the contextual `#N` card on every frame, so it must be a
 * pure local read. Each test points `OMP_GITHUB_CACHE_DB` at a temp file, so the user's real cache is never read,
 * and clears the process-wide repository map that the lookup depends on.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_REPO_RESOLVED } from "@oh-my-pi/pi-coding-agent/tools/gh-common";
import { putCached, resetForTests as resetCacheForTests } from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { lookupCachedReferenceTitle } from "@oh-my-pi/pi-coding-agent/tools/github-reference-title";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let tempDir: string;
let originalEnv: string | undefined;
let cwd: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-reference-title-"));
	originalEnv = process.env.OMP_GITHUB_CACHE_DB;
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	resetCacheForTests();
	DEFAULT_REPO_RESOLVED.clear();
	cwd = path.join(tempDir, "checkout");
	DEFAULT_REPO_RESOLVED.set(path.resolve(cwd), "owner/example");
});

afterEach(async () => {
	DEFAULT_REPO_RESOLVED.clear();
	resetCacheForTests();
	if (originalEnv === undefined) delete process.env.OMP_GITHUB_CACHE_DB;
	else process.env.OMP_GITHUB_CACHE_DB = originalEnv;
	await removeWithRetries(tempDir);
});

function cache(kind: "issue" | "pr", number: number, title: string, includeComments = false): void {
	putCached({
		repo: "owner/example",
		kind,
		number,
		includeComments,
		payload: { number, title },
		rendered: `${kind} ${number}`,
	});
}

describe("lookupCachedReferenceTitle", () => {
	it("returns the cached title for each kind of reference independently", () => {
		cache("pr", 12, "Fix the resize replay");
		cache("issue", 12, "Popup covers the input");

		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBe("Fix the resize replay");
		expect(lookupCachedReferenceTitle(cwd, "issue", "12")).toBe("Popup covers the input");
	});

	it("finds a title that was cached by a view with comments", () => {
		cache("pr", 7, "Only viewed with comments", true);

		expect(lookupCachedReferenceTitle(cwd, "pr", "7")).toBe("Only viewed with comments");
	});

	it("returns nothing for a number that was never opened", () => {
		cache("pr", 12, "Fix the resize replay");

		expect(lookupCachedReferenceTitle(cwd, "pr", "13")).toBeUndefined();
		expect(lookupCachedReferenceTitle(cwd, "issue", "12")).toBeUndefined();
	});

	it("returns nothing until the checkout's repository is known, without starting a lookup", () => {
		cache("pr", 12, "Fix the resize replay");
		DEFAULT_REPO_RESOLVED.clear();

		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBeUndefined();
		expect(DEFAULT_REPO_RESOLVED.size).toBe(0);
	});

	it("resolves the repository for the checkout it is asked about, not another one", () => {
		cache("pr", 12, "Fix the resize replay");
		DEFAULT_REPO_RESOLVED.set(path.resolve(path.join(tempDir, "other")), "owner/elsewhere");

		expect(lookupCachedReferenceTitle(path.join(tempDir, "other"), "pr", "12")).toBeUndefined();
		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBe("Fix the resize replay");
	});

	it("ignores tokens that are not positive integers", () => {
		cache("pr", 12, "Fix the resize replay");

		for (const token of ["0", "-1", "1.5", "abc", "", "99999999999999999999"]) {
			expect(lookupCachedReferenceTitle(cwd, "pr", token)).toBeUndefined();
		}
	});

	it("skips a cached view whose title is empty", () => {
		cache("pr", 12, "   ");

		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBeUndefined();
	});
});
