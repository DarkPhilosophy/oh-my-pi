import { describe, expect, it } from "bun:test";
import { handleServerCommand, parseServerCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/server";

describe("/server command", () => {
	it("parses supported operations and defaults to status", () => {
		expect(parseServerCommand("")).toBe("status");
		expect(parseServerCommand("sessions")).toBe("sessions");
		expect(parseServerCommand(" reconnect ")).toBe("reconnect");
		expect(parseServerCommand("stop now")).toBeNull();
	});

	it("dispatches injected callbacks without probing sockets", async () => {
		const calls: string[] = [];
		const output: string[] = [];
		await handleServerCommand("reconnect", {
			snapshot: { state: "direct" },
			output: text => {
				output.push(text);
			},
			reconnect: async () => {
				calls.push("reconnect");
			},
		});
		expect(calls).toEqual(["reconnect"]);
		expect(output).toEqual(["server reconnect requested"]);
	});

	it("reports shutdown blockers without claiming the daemon stopped", async () => {
		const output: string[] = [];
		await handleServerCommand("stop", {
			snapshot: { state: "direct" },
			output: text => {
				output.push(text);
			},
			stop: async () => ({ shutdown: false, blockers: ["clients", "protected_jobs"] }),
		});
		expect(output).toEqual(["server stop blocked: clients, protected_jobs"]);
	});

	it("confirms a successful daemon stop", async () => {
		const output: string[] = [];
		await handleServerCommand("stop", {
			snapshot: { state: "direct" },
			output: text => {
				output.push(text);
			},
			stop: async () => ({ shutdown: true, blockers: [] }),
		});
		expect(output).toEqual(["server stop requested"]);
	});
});
