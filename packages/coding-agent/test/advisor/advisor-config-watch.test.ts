import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as advisorConfig from "@oh-my-pi/pi-coding-agent/advisor/config";

let root: string | undefined;

afterEach(async () => {
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

const yaml = (name: string) => `advisors:\n  - name: ${name}\n    model: devin/swe-2\n`;

// A running session keeps the advisors it has until the user applies a change:
// `Save & apply` in `/advisor config` re-discovers and applies, and opening
// `/advisor config` reads the file fresh. Nothing watches WATCHDOG.yml, so one
// session's edit never rebuilds the advisors of the other sessions that are open.
it("does not offer a background watcher that reloads sessions on disk changes", () => {
	expect("watchAdvisorConfigs" in advisorConfig).toBe(false);
});

it("reads WATCHDOG.yml fresh on every discovery, so opening the editor sees an outside edit", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "watchdog-fresh-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	const file = path.join(agentDir, "WATCHDOG.yml");

	await Bun.write(file, yaml("AGI-Opus-5.5"));
	expect((await advisorConfig.discoverAdvisorConfigs(cwd, agentDir)).advisors.map(a => a.name)).toEqual([
		"AGI-Opus-5.5",
	]);

	// Atomic rename-over, the way editors and the config writer save.
	const tmp = `${file}.tmp`;
	await Bun.write(tmp, yaml("AGI-Sol-6"));
	await fs.rename(tmp, file);
	expect((await advisorConfig.discoverAdvisorConfigs(cwd, agentDir)).advisors.map(a => a.name)).toEqual(["AGI-Sol-6"]);
});
