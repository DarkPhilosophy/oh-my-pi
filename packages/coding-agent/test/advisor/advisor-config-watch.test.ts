import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAdvisorConfigs, watchAdvisorConfigs } from "@oh-my-pi/pi-coding-agent/advisor/config";

let stop: (() => void) | undefined;
let root: string | undefined;

afterEach(async () => {
	stop?.();
	stop = undefined;
	if (root) await fs.rm(root, { recursive: true, force: true });
	root = undefined;
});

const yaml = (name: string) => `advisors:\n  - name: ${name}\n    model: devin/swe-2\n`;

// A running session used to keep the advisor name and model it started with
// when WATCHDOG.yml was edited outside the in-app editor (another omp
// instance, an editor, an agent): discovery only ran at startup.
it("reloads advisors when WATCHDOG.yml is replaced on disk", async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "watchdog-watch-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	const file = path.join(agentDir, "WATCHDOG.yml");
	await Bun.write(file, yaml("AGI-Opus-5.5"));

	const names: string[][] = [];
	const changed = Promise.withResolvers<void>();
	stop = watchAdvisorConfigs(cwd, agentDir, () => {
		void discoverAdvisorConfigs(cwd, agentDir).then(found => {
			names.push(found.advisors.map(a => a.name));
			changed.resolve();
		});
	});

	// Atomic rename-over, the way editors and the config writer save.
	const tmp = `${file}.tmp`;
	await Bun.write(tmp, yaml("AGI-Sol-6"));
	await fs.rename(tmp, file);

	await Promise.race([changed.promise, Bun.sleep(3_000)]);
	expect(names.at(-1)).toEqual(["AGI-Sol-6"]);
});
