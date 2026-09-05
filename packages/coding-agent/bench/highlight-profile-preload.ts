// Use with: bun --preload ./packages/coding-agent/bench/highlight-profile-preload.ts
// packages/coding-agent/scripts/history-profile.ts --session <journal> --mode direct|daemon
// Records timings and sizes only; never records source text. Runs in the isolated profiler process.
import { spyOn } from "bun:test";
import * as native from "@oh-my-pi/pi-natives";

const original = native.highlightCode;
const slowest: Array<{ language: string; chars: number; ms: number }> = [];
let count = 0;
let totalMs = 0;
const probe = spyOn(native, "highlightCode").mockImplementation((code, language, colors) => {
	const start = performance.now();
	try {
		return original(code, language, colors);
	} finally {
		const ms = performance.now() - start;
		count++;
		totalMs += ms;
		if (slowest.length < 12 || ms > slowest[slowest.length - 1].ms) {
			slowest.push({ language: language ?? "", chars: code.length, ms });
			slowest.sort((a, b) => b.ms - a.ms);
			if (slowest.length > 12) slowest.pop();
		}
	}
});
process.on("exit", () => {
	probe.mockRestore();
	console.error(JSON.stringify({ highlightCalls: count, totalMs, slowest }));
});
