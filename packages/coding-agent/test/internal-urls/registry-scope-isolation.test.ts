import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/agent-protocol";
import { HistoryProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/history-protocol";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry, createAgentRegistryScope } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});

it("isolates agent and history artifacts between registry scopes", async () => {
	const tempDir = TempDir.createSync("omp-registry-scope-isolation-");
	try {
		const scopeA = createAgentRegistryScope(new AgentRegistry());
		const scopeB = createAgentRegistryScope(new AgentRegistry());
		const dirA = path.join(tempDir.path(), "a");
		const dirB = path.join(tempDir.path(), "b");
		await fs.mkdir(dirA, { recursive: true });
		await fs.mkdir(dirB, { recursive: true });
		await fs.writeFile(path.join(dirA, "A.md"), "scope A output");
		await fs.writeFile(path.join(dirB, "B.md"), "scope B output");
		await fs.writeFile(path.join(dirA, "A.jsonl"), "");
		await fs.writeFile(path.join(dirB, "B.jsonl"), "");

		const agent = new AgentProtocolHandler();
		const history = new HistoryProtocolHandler();
		await scopeA.run(async () => {
			registerArtifactsDir(dirA);
			expect((await agent.resolve(new URL("agent://A") as never)).content).toBe("scope A output");
			expect((await agent.complete()).map(item => item.value)).toEqual(["A"]);
			expect((await history.resolve(new URL("history://A") as never)).content).toContain("# A");
			expect((await history.complete()).map(item => item.value)).toEqual(["A"]);
			await expect(agent.resolve(new URL("agent://B") as never)).rejects.toThrow("Not found: B");
			await expect(history.resolve(new URL("history://B") as never)).rejects.toThrow("Unknown agent: B");
		});

		await scopeB.run(async () => {
			registerArtifactsDir(dirB);
			expect((await agent.resolve(new URL("agent://B") as never)).content).toBe("scope B output");
			expect((await agent.complete()).map(item => item.value)).toEqual(["B"]);
			expect((await history.resolve(new URL("history://B") as never)).content).toContain("# B");
			expect((await history.complete()).map(item => item.value)).toEqual(["B"]);
			await expect(agent.resolve(new URL("agent://A") as never)).rejects.toThrow("Not found: A");
			await expect(history.resolve(new URL("history://A") as never)).rejects.toThrow("Unknown agent: A");
		});
	} finally {
		tempDir.removeSync();
	}
});
