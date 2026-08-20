import { describe, expect, it } from "bun:test";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
	getBuiltinSlashCommandOwnership,
	lookupBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { handleServerCommand, parseServerCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/server";

describe("/daemon command", () => {
	it("parses supported operations and defaults to status", () => {
		expect(parseServerCommand("")).toBe("status");
		expect(parseServerCommand("sessions")).toBe("sessions");
		expect(parseServerCommand(" reconnect ")).toBe("reconnect");
		expect(parseServerCommand("kill --force")).toBe("kill");
		expect(parseServerCommand("refresh --graceful")).toBe("refresh");
		expect(parseServerCommand("stop now")).toBeNull();
		expect(parseServerCommand("kill grateful")).toBeNull();
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

		expect(lookupBuiltinSlashCommand("daemon")).toBeDefined();
		expect(lookupBuiltinSlashCommand("server")).toBeDefined();
		expect(getBuiltinSlashCommandOwnership("daemon")).toBe("client");
		expect(await executeBuiltinSlashCommand("/daemon sessions", runtime)).toBe(true);
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
		expect(output).toEqual(["daemon reconnect requested"]);
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
		expect(output).toEqual(["daemon stop blocked: clients, protected_jobs"]);
	});

	it("maps kill and refresh with force through injected callbacks", async () => {
		const calls: Array<[string, boolean | undefined]> = [];
		const output: string[] = [];
		const callbacks = {
			snapshot: { state: "direct" as const },
			output: (text: string) => {
				output.push(text);
			},
			kill: (force?: boolean) => {
				calls.push(["kill", force]);
				return { shutdown: true, blockers: [] };
			},
			refresh: (force?: boolean) => {
				calls.push(["refresh", force]);
				return { shutdown: true, blockers: [] };
			},
		};
		await handleServerCommand("kill --force", callbacks);
		await handleServerCommand("refresh --graceful", callbacks);
		expect(calls).toEqual([
			["kill", true],
			["refresh", false],
		]);
		expect(output).toEqual(["daemon kill requested forcefully", "daemon refresh requested"]);
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
		expect(output).toEqual(["daemon stop requested"]);
	});
});
