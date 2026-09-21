import * as path from "node:path";
import * as jsc from "bun:jsc";
import { getLogsDir, logger } from "@oh-my-pi/pi-utils";

interface SamplingFrame {
	name: string;
	sourceURL?: string;
	line: number;
	column: number;
}

interface SamplingTraces {
	interval: number;
	traces: Array<{ timestamp: number; frames: SamplingFrame[] }>;
}

/**
 * `samplingProfilerStackTraces` exists at runtime (Bun 1.3) but is not in the
 * published `bun:jsc` declarations yet. Each call drains the buffer (verified:
 * consecutive calls return disjoint sample sets), which is what scopes a report
 * to the interval since the previous drain.
 */
const drainSamples: (() => SamplingTraces) | undefined = (
	jsc as unknown as { samplingProfilerStackTraces?: () => SamplingTraces }
).samplingProfilerStackTraces;

/**
 * Opt-in (`OMP_LOOP_PROFILE=1`) JavaScript sampling profiler scoped to
 * watchdog blocks. The watchdog cannot profile a stall after the fact and a
 * whole-session `--cpu-prof` attributes idle time to whatever frame last ran,
 * so instead the engine samples continuously at 1 ms, the watchdog discards
 * the samples on every healthy tick, and on the rising edge of a block the
 * samples accumulated since the previous tick - the block itself - are
 * aggregated into a small text report next to the session log.
 *
 * The report lists self time (top of stack) and inclusive time per
 * `function file:line`, which is the only attribution that names the actual
 * synchronous work instead of the phase breadcrumb that happened to be open.
 */
export class LoopProfiler {
	#enabled = false;
	#sequence = 0;

	start(): void {
		if (this.#enabled || process.env.OMP_LOOP_PROFILE === undefined || drainSamples === undefined) return;
		try {
			jsc.startSamplingProfiler();
			this.#enabled = true;
			logger.info("ui.loop-profile armed", { dir: getLogsDir() });
		} catch (err) {
			logger.warn("ui.loop-profile unavailable", { error: String(err) });
		}
	}

	get enabled(): boolean {
		return this.#enabled;
	}

	/** Drop the samples of a healthy interval so a later block's report holds only the block. */
	discard(): void {
		if (!this.#enabled) return;
		try {
			drainSamples?.();
		} catch {
			// Losing a discard only widens the next report; never fail the watchdog tick.
		}
	}

	/** Aggregate the samples since the last drain and write them as a report. Returns its path. */
	report(blockedMs: number, phase: string): string | undefined {
		if (!this.#enabled || drainSamples === undefined) return undefined;
		let traces: SamplingTraces;
		try {
			traces = drainSamples();
		} catch (err) {
			logger.warn("ui.loop-profile drain failed", { error: String(err) });
			return undefined;
		}
		const summary = summarizeTraces(traces);
		const file = path.join(getLogsDir(), `loop-profile.${process.pid}.${++this.#sequence}.txt`);
		const header = `blockedMs=${blockedMs} phase=${phase} samples=${summary.samples} at=${new Date().toISOString()}\n`;
		void Bun.write(file, `${header}\n== self ==\n${summary.self}\n\n== inclusive ==\n${summary.inclusive}\n`).catch(
			err => logger.warn("ui.loop-profile write failed", { error: String(err) }),
		);
		return file;
	}
}

const TOP_N = 40;
const UNKNOWN_LINE = 4294967295;

function frameKey(frame: SamplingFrame): string {
	const file = frame.sourceURL ? frame.sourceURL.split("/").slice(-2).join("/") : "(native)";
	const line = frame.line === UNKNOWN_LINE ? "" : `:${frame.line}`;
	return `${frame.name || "(anonymous)"} ${file}${line}`;
}

function summarizeTraces(traces: SamplingTraces): { samples: number; self: string; inclusive: string } {
	const self = new Map<string, number>();
	const inclusive = new Map<string, number>();
	let samples = 0;
	for (const trace of traces.traces) {
		if (trace.frames.length === 0) continue;
		samples++;
		const top = frameKey(trace.frames[0]!);
		self.set(top, (self.get(top) ?? 0) + 1);
		const seen = new Set<string>();
		for (const frame of trace.frames) {
			const key = frameKey(frame);
			if (seen.has(key)) continue;
			seen.add(key);
			inclusive.set(key, (inclusive.get(key) ?? 0) + 1);
		}
	}
	const format = (counts: Map<string, number>): string =>
		[...counts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, TOP_N)
			.map(
				([key, count]) =>
					`${String(count).padStart(6)} ${((count / Math.max(1, samples)) * 100).toFixed(1).padStart(5)}%  ${key}`,
			)
			.join("\n");
	return { samples, self: format(self), inclusive: format(inclusive) };
}
