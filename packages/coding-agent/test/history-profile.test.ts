import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FairnessBenchmarkResult } from "../scripts/daemon-bench";
import { SessionManager } from "../src/session/session-manager";

test("direct and daemon renderer profiles preserve their source journal", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-history-profile-test-"));
	const manager = SessionManager.create(root, root);
	let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
	try {
		manager.appendMessage({ role: "user", content: "Profiling fixture", timestamp: 1 });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "```typescript\nconst answer: number = 42;\n```" }],
			api: "openai-responses",
			provider: "openai",
			model: "fixture",
			timestamp: 2,
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		await manager.ensureOnDisk();
		await manager.close();
		const source = manager.getSessionFile();
		if (!source) throw new Error("Fixture journal not persisted");
		const before = await Bun.file(source).text();
		let digest: string | undefined;
		for (const mode of ["direct", "daemon"]) {
			const output = path.join(root, `${mode}.json`);
			child = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "../scripts/history-profile.ts"),
					"--session",
					source,
					"--mode",
					mode,
					"--rewrite",
					"--output",
					output,
				],
				{
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: path.join(root, "agent") },
				},
			);
			// Real child-process watchdog only; completion is awaited from child.exited,
			// not guessed from a delay. Fake timers cannot terminate a hung subprocess.
			const timeout = setTimeout(() => child?.kill(), 20_000);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			clearTimeout(timeout);
			if (exitCode !== 0) throw new Error(`Profiler ${mode} failed: ${stderr}`);
			const report = JSON.parse(stdout);
			expect(await Bun.file(output).json()).toEqual(report);
			expect(report.mode).toBe(mode);
			expect(report.socketTransportIncluded).toBe(false);
			expect(report.phases.map((phase: { name: string }) => phase.name)).toEqual([
				"load-session",
				"initialize-interactive-session",
				"cold-replay",
				"warm-replay",
				"rewrite-and-flush",
			]);
			expect(
				report.phases.find((phase: { name: string }) => phase.name === "cold-replay").outputBytes,
			).toBeGreaterThan(0);
			expect(report.activeMessages).toBe(2);
			if (digest) expect(report.inputSha256).toBe(digest);
			digest = report.inputSha256;
			expect(await Bun.file(source).text()).toBe(before);
		}
	} finally {
		child?.kill();
		await manager.close();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);

// Opt-in: this starts an isolated real daemon plus two attached sessions.
// Keep it available without adding process startup cost to every unit-test run.
test.skipIf(process.platform !== "linux" || process.env.OMP_PROFILE_DAEMON !== "1")(
	"profiles real daemon socket contention without losing session commands",
	async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				path.resolve(import.meta.dir, "../scripts/daemon-bench.ts"),
				"--fairness",
				"--n",
				"2",
				"--probes",
				"5",
				"--trials",
				"1",
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		try {
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (exitCode !== 0) throw new Error(`Daemon profiler failed: ${stderr}`);
			const report: FairnessBenchmarkResult = JSON.parse(stdout);
			expect(report.phase).toBe("daemon-fairness");
			expect(report.heavyFailures).toBe(0);
			expect(report.heavyOps).toBeGreaterThan(0);
			expect(report.combinedVictim.count).toBe(5);
			for (const lane of [...report.victimLanes, report.statusLane]) {
				expect(lane.failures).toBe(0);
				expect(lane.latency.count).toBe(5);
			}
		} finally {
			child.kill();
		}
	},
	60_000,
);
