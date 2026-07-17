import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	createProjectDirContextKey,
	createProjectDirScope,
	getProjectDir,
	getProjectDirContextValue,
	peekProjectDirContextValue,
	setProjectDir,
	setProjectDirContextValue,
	withProjectDir,
} from "../src/dirs";

describe("project directory context", () => {
	test("isolates concurrent async project directories without changing process cwd", async () => {
		const globalProjectDir = getProjectDir();
		const processCwd = process.cwd();
		const firstDir = path.resolve(processCwd, "first-project");
		const secondDir = path.resolve(processCwd, "second-project");
		const firstReady = Promise.withResolvers<void>();
		const secondReady = Promise.withResolvers<void>();

		const first = withProjectDir(firstDir, async () => {
			firstReady.resolve();
			await secondReady.promise;
			expect(getProjectDir()).toBe(firstDir);
			setProjectDir(path.join(firstDir, "nested"));
			await Bun.sleep(0);
			return getProjectDir();
		});
		const second = withProjectDir(secondDir, async () => {
			secondReady.resolve();
			await firstReady.promise;
			expect(getProjectDir()).toBe(secondDir);
			await Bun.sleep(0);
			return getProjectDir();
		});

		expect(await Promise.all([first, second])).toEqual([path.join(firstDir, "nested"), secondDir]);
		expect(getProjectDir()).toBe(globalProjectDir);
		expect(process.cwd()).toBe(processCwd);
	});

	test("keeps contextual values isolated between reusable session scopes", () => {
		const key = createProjectDirContextKey<string[]>("test-values");
		const first = createProjectDirScope(process.cwd());
		const second = createProjectDirScope(process.cwd());

		first.run(() => getProjectDirContextValue(key, () => []).push("first"));
		second.run(() => getProjectDirContextValue(key, () => []).push("second"));

		expect(first.run(() => getProjectDirContextValue(key, () => []))).toEqual(["first"]);
		expect(second.run(() => getProjectDirContextValue(key, () => []))).toEqual(["second"]);
	});

	test("sets and peeks values only inside the active reusable scope", () => {
		const key = createProjectDirContextKey<string>("test-bound-value");
		const first = createProjectDirScope(process.cwd());
		const second = createProjectDirScope(process.cwd());

		first.run(() => setProjectDirContextValue(key, "first"));

		expect(first.run(() => peekProjectDirContextValue(key))).toBe("first");
		expect(second.run(() => peekProjectDirContextValue(key))).toBeUndefined();
	});
});
