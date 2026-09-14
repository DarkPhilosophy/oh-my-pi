import { expect, it } from "bun:test";
import { acquireBrowser, releaseBrowser } from "../../src/tools/browser/registry";

it("excludes other processes until the Firefox endpoint owner releases its handle", async () => {
	const webSocketUrl = `ws://localhost:9222/lease-${crypto.randomUUID()}`;
	const kind = { kind: "firefox-relay" as const, webSocketUrl };
	const handle = await acquireBrowser(kind, { cwd: process.cwd() });
	const probe = async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				`${import.meta.dir}/../fixtures/firefox-endpoint-lease-probe.ts`,
				webSocketUrl.replace("localhost", "127.0.0.1"),
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(stderr).toBe("");
		return { exitCode, stdout: stdout.trim() };
	};
	try {
		expect(await probe()).toEqual({ exitCode: 0, stdout: "contended" });
	} finally {
		await releaseBrowser(handle, { kill: false });
	}
	expect(await probe()).toEqual({ exitCode: 0, stdout: "acquired" });
}, 15_000);
