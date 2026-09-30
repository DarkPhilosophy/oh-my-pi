/**
 * `lookupCachedReferenceTitle` feeds the caption of the contextual `#N` card on every frame, so it must be a
 * pure local read. Each test points `OMP_GITHUB_CACHE_DB` at a temp file, so the user's real cache is never read,
 * pins the credential environment that keys the cache, and clears the process-wide repository map that the lookup
 * depends on. Views are written through `getOrFetchView`, the path `pr://` and `issue://` reads use.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_REPO_RESOLVED } from "@oh-my-pi/pi-coding-agent/tools/gh-common";
import {
	getOrFetchView,
	resetForTests as resetCacheForTests,
	resolveGithubCacheAuthKey,
} from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { lookupCachedReferenceTitle } from "@oh-my-pi/pi-coding-agent/tools/github-reference-title";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const ENV_KEYS = [
	"OMP_GITHUB_CACHE_DB",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GH_CONFIG_DIR",
];

let tempDir: string;
let cwd: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-reference-title-"));
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	process.env.GH_CONFIG_DIR = path.join(tempDir, "gh-config");
	process.env.GH_TOKEN = "token-one";
	resetCacheForTests();
	DEFAULT_REPO_RESOLVED.clear();
	cwd = path.join(tempDir, "checkout");
	DEFAULT_REPO_RESOLVED.set(path.resolve(cwd), "owner/example");
});

afterEach(async () => {
	DEFAULT_REPO_RESOLVED.clear();
	resetCacheForTests();
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await removeWithRetries(tempDir);
});

/** Store a view the way a real read does: under the identity key of the active credentials. */
async function cache(kind: "issue" | "pr", number: number, title: string, includeComments = false): Promise<void> {
	const authKey = resolveGithubCacheAuthKey();
	expect(authKey).toBeDefined();
	await getOrFetchView({
		repo: "owner/example",
		kind,
		number,
		includeComments,
		authKey,
		fetchFresh: async () => ({ rendered: `${kind} ${number}`, sourceUrl: undefined, payload: { number, title } }),
	});
}

describe("lookupCachedReferenceTitle", () => {
	it("returns the cached title for each kind of reference independently", async () => {
		await cache("pr", 12, "Fix the resize replay");
		await cache("issue", 12, "Popup covers the input");

		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBe("Fix the resize replay");
		expect(lookupCachedReferenceTitle(cwd, "issue", "12")).toBe("Popup covers the input");
	});

	it("finds a title that was cached by a view with comments", async () => {
		await cache("pr", 7, "Only viewed with comments", true);

		expect(lookupCachedReferenceTitle(cwd, "pr", "7")).toBe("Only viewed with comments");
	});

	it("returns nothing for a number that was never opened", async () => {
		await cache("pr", 12, "Fix the resize replay");

		expect(lookupCachedReferenceTitle(cwd, "pr", "13")).toBeUndefined();
		expect(lookupCachedReferenceTitle(cwd, "issue", "12")).toBeUndefined();
	});

	it("returns nothing until the checkout's repository is known, without starting a lookup", async () => {
		await cache("pr", 12, "Fix the resize replay");
		DEFAULT_REPO_RESOLVED.clear();

		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBeUndefined();
		expect(DEFAULT_REPO_RESOLVED.size).toBe(0);
	});

	it("resolves the repository for the checkout it is asked about, not another one", async () => {
		await cache("pr", 12, "Fix the resize replay");
		DEFAULT_REPO_RESOLVED.set(path.resolve(path.join(tempDir, "other")), "owner/elsewhere");

		expect(lookupCachedReferenceTitle(path.join(tempDir, "other"), "pr", "12")).toBeUndefined();
		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBe("Fix the resize replay");
	});

	it("ignores tokens that are not positive integers", async () => {
		await cache("pr", 12, "Fix the resize replay");

		for (const token of ["0", "-1", "1.5", "abc", "", "99999999999999999999"]) {
			expect(lookupCachedReferenceTitle(cwd, "pr", token)).toBeUndefined();
		}
	});

	it("skips a cached view whose title is empty", async () => {
		await cache("pr", 12, "   ");

		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBeUndefined();
	});

	it("shows a title only to the identity that cached it, and nothing without an identity", async () => {
		await cache("pr", 12, "Cached by account one");
		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBe("Cached by account one");

		process.env.GH_TOKEN = "token-two";
		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBeUndefined();

		delete process.env.GH_TOKEN;
		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBeUndefined();
	});
});
