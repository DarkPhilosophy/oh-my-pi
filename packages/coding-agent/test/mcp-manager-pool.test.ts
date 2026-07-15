import { describe, expect, it, vi } from "bun:test";
import {
	type MCPManager,
	MCPManagerPool,
	type MCPToolsLoadOptions,
	type MCPToolsLoadResult,
} from "@oh-my-pi/pi-coding-agent/mcp";

function loadResult(manager: MCPManager): MCPToolsLoadResult {
	return {
		manager,
		tools: [],
		errors: [],
		connectedServers: [],
		exaApiKeys: [],
	};
}

describe("MCPManagerPool", () => {
	it("deduplicates equivalent shard loads and disconnects the shared manager once", async () => {
		const disconnectAll = vi.fn(async () => {});
		const manager = { disconnectAll } as unknown as MCPManager;
		const load = vi.fn(async (_cwd: string, _options?: MCPToolsLoadOptions) => loadResult(manager));
		const pool = new MCPManagerPool(load);
		const options: MCPToolsLoadOptions = {
			enableProjectConfig: true,
			filterExa: true,
			filterBrowser: true,
		};

		const [first, second] = await Promise.all([
			pool.acquire("/workspace/project", options),
			pool.acquire("/workspace/project", options),
		]);

		expect(first.manager).toBe(manager);
		expect(second.manager).toBe(manager);
		expect(load).toHaveBeenCalledTimes(1);

		await pool.dispose();
		expect(disconnectAll).toHaveBeenCalledTimes(1);
	});

	it("keeps managers separate when cwd or discovery filters differ", async () => {
		const managers: MCPManager[] = [];
		const load = vi.fn(async (_cwd: string, _options?: MCPToolsLoadOptions) => {
			const manager = { disconnectAll: vi.fn(async () => {}) } as unknown as MCPManager;
			managers.push(manager);
			return loadResult(manager);
		});
		const pool = new MCPManagerPool(load);

		await pool.acquire("/workspace/project", { filterBrowser: true });
		await pool.acquire("/workspace/other", { filterBrowser: true });
		await pool.acquire("/workspace/project", { filterBrowser: false });

		expect(load).toHaveBeenCalledTimes(3);
		expect(managers).toHaveLength(3);
		await pool.dispose();
	});
});
