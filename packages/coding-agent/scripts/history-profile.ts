#!/usr/bin/env bun
/**
 * Offline profiling of real transcript replay through direct and daemon-hosted
 * renderers. No provider requests, extensions, or local inference are started.
 * Each invocation copies its input and runs in a fresh process, so cold/warm
 * measurements remain comparable. Socket/client scheduling is measured separately
 * by daemon-bench.ts --fairness; this probe deliberately isolates rendering.
 *
 * bun scripts/history-profile.ts --session <file> --mode direct --output <json>
 * bun scripts/history-profile.ts --session <file> --mode daemon --output <json>
 * Add --rewrite to profile full-history persistence on the disposable copy.
 */
import { profile } from "bun:jsc";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { HostedTerminal } from "../src/daemon/terminal-bridge";
import { Composer } from "../src/modes/composer";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { initTheme } from "../src/modes/theme/theme";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		session: { type: "string" },
		mode: { type: "string", default: "direct" },
		output: { type: "string" },
		columns: { type: "string", default: "100" },
		rows: { type: "string", default: "30" },
		rewrite: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	},
	strict: true,
});
if (values.help) {
	console.log(
		"Usage: bun scripts/history-profile.ts --session <jsonl> --mode direct|daemon [--output <json>] [--columns 100] [--rows 30] [--rewrite]\nProfiles complete cold/warm replay, event-loop gaps, CPU, memory and output. Daemon mode uses the real HostedTerminal renderer; socket transport is excluded. For transport contention use scripts/daemon-bench.ts --fairness. Input is copied and never modified. Run each mode in a separate invocation. Large transcripts require corresponding RAM; --rewrite additionally writes a full disposable copy.",
	);
	process.exit(0);
}
if (!values.session) throw new Error("--session is required");
if (values.mode !== "direct" && values.mode !== "daemon") throw new Error("--mode must be direct or daemon");
const columns = Number(values.columns);
const rows = Number(values.rows);
if (!Number.isSafeInteger(columns) || columns < 20 || columns > 1000)
	throw new Error("--columns must be between 20 and 1000");
if (!Number.isSafeInteger(rows) || rows < 5 || rows > 300) throw new Error("--rows must be between 5 and 300");
const source = path.resolve(values.session);
if (values.output && path.resolve(values.output) === source)
	throw new Error("--output must not replace the input session");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-history-profile-"));
let mode: InteractiveMode | undefined;
let session: AgentSession | undefined;
let manager: SessionManager | undefined;
let auth: AuthStorage | undefined;
let hosted: HostedTerminal | undefined;
const phases: Array<{
	name: string;
	elapsedMs: number;
	maxEventLoopGapMs: number;
	heartbeatTicks: number;
	cpuUserMs: number;
	cpuSystemMs: number;
	heapBefore: number;
	heapAfter: number;
	rssBefore: number;
	rssAfter: number;
	outputBytes: number;
	outputWrites: number;
	scrollbackClears: number;
	functions: string;
}> = [];
let outputBytes = 0;
let outputWrites = 0;
let scrollbackClears = 0;
class RecordingTerminal extends VirtualTerminal {
	override write(data: string): void {
		outputBytes += Buffer.byteLength(data);
		outputWrites++;
		scrollbackClears += data.split("\x1b[3J").length - 1;
		super.write(data);
	}
}
async function measure(name: string, operation: () => Promise<void>): Promise<void> {
	const start = performance.now();
	const cpu = process.cpuUsage();
	const before = process.memoryUsage();
	const bytesBefore = outputBytes;
	const writesBefore = outputWrites;
	const clearsBefore = scrollbackClears;
	let lastTick = start;
	let maxEventLoopGapMs = 0;
	let heartbeatTicks = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxEventLoopGapMs = Math.max(maxEventLoopGapMs, now - lastTick);
		lastTick = now;
		heartbeatTicks++;
	}, 1);
	try {
		const sampled = await profile(operation, 100);
		const end = performance.now();
		maxEventLoopGapMs = Math.max(maxEventLoopGapMs, end - lastTick);
		const consumed = process.cpuUsage(cpu);
		const after = process.memoryUsage();
		phases.push({
			name,
			elapsedMs: end - start,
			maxEventLoopGapMs,
			heartbeatTicks,
			cpuUserMs: consumed.user / 1000,
			cpuSystemMs: consumed.system / 1000,
			heapBefore: before.heapUsed,
			heapAfter: after.heapUsed,
			rssBefore: before.rss,
			rssAfter: after.rss,
			outputBytes: outputBytes - bytesBefore,
			outputWrites: outputWrites - writesBefore,
			scrollbackClears: scrollbackClears - clearsBefore,
			functions: sampled.functions,
		});
	} finally {
		clearInterval(timer);
	}
}
try {
	const copy = path.join(root, "session.jsonl");
	await fs.copyFile(source, copy);
	const digest = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(copy).stream()) digest.update(chunk);
	const inputSha256 = digest.digest("hex");
	const inputBytes = (await fs.stat(copy)).size;
	await measure("load-session", async () => {
		manager = await SessionManager.open(copy, root, undefined, { suppressBreadcrumb: true });
	});
	if (!manager) throw new Error("Session failed to load");
	const sessionManager = manager;
	await Settings.init({ inMemory: true, cwd: root });
	initTheme();
	auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth);
	const model = registry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Missing bundled rendering fixture model");
	const agent = new Agent({ initialState: { model, tools: [], messages: manager.buildSessionContext().messages } });
	session = new AgentSession({
		agent,
		sessionManager,
		modelRegistry: registry,
		settings: Settings.isolated({
			"speech.enabled": false,
			"features.unexpectedStopDetection": "none",
			"compaction.enabled": false,
		}),
	});
	const terminal = new RecordingTerminal(columns, rows);
	if (values.mode === "daemon") {
		hosted = new HostedTerminal({ columns, rows, kittyProtocolActive: false, kittyEnableSequence: null });
		hosted.setOutput(data => terminal.write(data));
		mode = new InteractiveMode(session, "profile", undefined, () => {}, undefined, undefined, undefined, {
			terminal: hosted,
			onDetach: () => hosted?.setOutput(undefined),
		});
	} else {
		mode = new InteractiveMode(
			session,
			"profile",
			undefined,
			() => {},
			undefined,
			undefined,
			undefined,
			new Composer({ terminal }),
		);
	}
	await measure("initialize-interactive-session", async () => {
		await mode!.init({ suppressWelcomeIntro: true });
	});
	const activeMode = mode;
	for (const name of ["cold-replay", "warm-replay"]) {
		await measure(name, async () => {
			await activeMode.renderInitialMessages();
			activeMode.ui.renderNow();
			await terminal.waitForRender();
		});
	}
	if (values.rewrite)
		await measure("rewrite-and-flush", async () => {
			await sessionManager.rewriteEntries();
			await sessionManager.flush();
		});
	const report = {
		schemaVersion: 1,
		mode: values.mode,
		scope: "offline-renderer-and-persistence",
		socketTransportIncluded: false,
		inputSha256,
		inputBytes,
		entries: sessionManager.getEntries().length,
		activeMessages: agent.state.messages.length,
		columns,
		rows,
		bun: Bun.version,
		platform: process.platform,
		phases,
	};
	const serialized = `${JSON.stringify(report, null, 2)}\n`;
	if (values.output) await Bun.write(path.resolve(values.output), serialized);
	console.log(serialized);
} finally {
	mode?.stop();
	hosted?.setOutput(undefined);
	if (session) await session.dispose();
	else await manager?.close();
	auth?.close();
	await fs.rm(root, { recursive: true, force: true });
}
