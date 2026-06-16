import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import {
	createMemoryRuntimeContext,
	createSessionMemoryRuntimeContext,
	resolveMemoryBackend,
} from "@oh-my-pi/pi-coding-agent/memory-backend";

describe("resolveMemoryBackend", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("returns the hindsight backend when memory.backend is hindsight, regardless of legacy memories.enabled", async () => {
		const a = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": false });
		const b = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": true });
		expect((await resolveMemoryBackend(a)).id).toBe("hindsight");
		expect((await resolveMemoryBackend(b)).id).toBe("hindsight");
	});

	it("exposes inactive status when no session is available", async () => {
		const memory = createMemoryRuntimeContext({ agentDir: "/tmp/agent", cwd: "/tmp/project" });

		await expect(memory.status()).resolves.toMatchObject({
			backend: "off",
			active: false,
			writable: false,
			searchable: false,
		});
	});

	it("reports local backend runtime status as writable (lessons) without structured search", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const memory = createMemoryRuntimeContext({
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			session: { settings } as never,
		});

		await expect(memory.status()).resolves.toMatchObject({
			backend: "local",
			active: true,
			writable: true,
			searchable: false,
		});
		await expect(memory.search("project preference")).resolves.toMatchObject({
			backend: "local",
			count: 0,
		});
	});

	it("recomputes session cwd for each runtime memory operation", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-runtime-"));
		let cwd = "/tmp/project-a";
		const memory = createSessionMemoryRuntimeContext({ settings } as never, agentDir, () => cwd);

		try {
			await memory.save("first lesson");
			cwd = "/tmp/project-b";
			await memory.save("second lesson");

			const first = await Bun.file(path.join(getMemoryRoot(agentDir, "/tmp/project-a"), "learned.md")).text();
			const second = await Bun.file(path.join(getMemoryRoot(agentDir, "/tmp/project-b"), "learned.md")).text();
			expect(first).toContain("first lesson");
			expect(first).not.toContain("second lesson");
			expect(second).toContain("second lesson");
			expect(second).not.toContain("first lesson");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
