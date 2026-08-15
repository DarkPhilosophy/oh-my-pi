import { describe, expect, it } from "bun:test";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
	getBuiltinSlashCommandOwnership,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { handleServerCommand, parseServerCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/server";

describe("/server command", () => {
	it("parses supported operations and defaults to status", () => {
		expect(parseServerCommand("")).toBe("status");
		expect(parseServerCommand("sessions")).toBe("sessions");
		expect(parseServerCommand(" reconnect ")).toBe("reconnect");
		expect(parseServerCommand("stop now")).toBeNull();
	});

	it("is registered and dispatches injected TUI controls", async () => {
		const output: string[] = [];
		const editorText: string[] = [];
		const runtime = {
			ctx: {
				editor: {
					setText: (text: string) => {
						editorText.push(text);
					},
				},
				showStatus: (text: string) => {
					output.push(text);
				},
				server: {
					snapshot: { state: "connected", shard: { profile: "default", projectRoot: "/tmp/project" } },
					sessions: () => "session-a\nsession-b",
				},
			},
		} as unknown as BuiltinSlashCommandRuntime;

		expect(lookupBuiltinSlashCommand("server")).toBeDefined();
		expect(getBuiltinSlashCommandOwnership("server")).toBe("client");
		expect(await executeBuiltinSlashCommand("/server sessions", runtime)).toBe(true);
		expect(editorText).toEqual([""]);
		expect(output).toEqual(["session-a\nsession-b"]);
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
