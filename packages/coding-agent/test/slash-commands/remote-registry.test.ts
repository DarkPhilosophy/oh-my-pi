import { describe, expect, it } from "bun:test";
import {
	buildAvailableSlashCommands,
	getClientOwnedBuiltinSlashCommands,
} from "../../src/slash-commands/available-commands";
import { getBuiltinSlashCommandOwnership } from "../../src/slash-commands/builtin-registry";

describe("remote slash-command registry", () => {
	it("exposes client-owned builtins separately from daemon-owned builtins", () => {
		expect(getBuiltinSlashCommandOwnership("settings")).toBe("client");
		expect(getBuiltinSlashCommandOwnership("hotkeys")).toBe("client");
		expect(getBuiltinSlashCommandOwnership("model")).toBe("daemon");
		expect(getBuiltinSlashCommandOwnership("plugin:custom")).toBeUndefined();
	});

	it("includes client-owned builtins when building the remote palette", async () => {
		const commands = await buildAvailableSlashCommands(
			{
				customCommands: [],
				skills: [],
				setSlashCommands() {},
				sessionManager: { getCwd: () => "." },
			},
			async () => [],
			{ includeClientOwnedBuiltins: true },
		);
		expect(commands.some(command => command.name === "settings")).toBe(true);
	});
	it("marks dynamic plugin commands daemon-owned in the combined palette", async () => {
		const commands = await buildAvailableSlashCommands(
			{
				extensionRunner: { getRegisteredCommands: () => [{ name: "plugin:custom", description: "Plugin" }] },
				customCommands: [{ command: { name: "custom:prompt", description: "Custom" } }],
				skills: [],
				setSlashCommands() {},
				sessionManager: { getCwd: () => "." },
			} as never,
			async () => [],
			{ includeClientOwnedBuiltins: true },
		);
		const byName = Object.fromEntries(commands.map(command => [command.name, command]));
		expect(byName.settings.owner).toBe("client");
		expect(byName.hotkeys.owner).toBe("client");
		expect(byName.model.owner).toBe("daemon");
		expect(byName["plugin:custom"].owner).toBe("daemon");
		expect(byName["custom:prompt"].owner).toBe("daemon");
		expect(getClientOwnedBuiltinSlashCommands().some(command => command.name === "settings")).toBe(true);
	});
});
