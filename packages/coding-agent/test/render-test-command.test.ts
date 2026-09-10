import { afterEach, beforeEach, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "../src/slash-commands/builtin-control";

let directory: TempDir;
let auth: AuthStorage;
let session: AgentSession;
let providerCalls: number;
let credentialCalls: number;

beforeEach(async () => {
	directory = TempDir.createSync("omp-render-test-");
	auth = await AuthStorage.create(":memory:");
	providerCalls = 0;
	credentialCalls = 0;
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		initialState: { model, tools: [] },
		getApiKey: () => {
			credentialCalls++;
			throw new Error("Render test requested credentials");
		},
		streamFn: () => {
			providerCalls++;
			throw new Error("Render test contacted a provider");
		},
	});
	session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(directory.path()),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(auth, directory.join("models.yml")),
	});
});

afterEach(async () => {
	await session?.dispose();
	auth?.close();
	await directory?.remove();
});

it("streams the render command incrementally through session events and persists its completed assistant message", async () => {
	const firstDelta = Promise.withResolvers<void>();
	let partial = "";
	let final: AssistantMessage | undefined;
	let idleAtEnd = false;
	session.subscribe(event => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			partial += event.assistantMessageEvent.delta;
			firstDelta.resolve();
		}
		if (event.type === "message_end" && event.message.role === "assistant") final = event.message;
		if (event.type === "agent_end") idleAtEnd = !session.isStreaming;
	});
	const command = BUILTIN_CONTROL_SLASH_COMMANDS.find(candidate => candidate.name === "render");
	if (!command?.handle) throw new Error("Missing /render command");
	const errors: string[] = [];
	const running = command.handle(
		{ name: "render", args: "test 3 1", text: "/render test 3 1" },
		{
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			cwd: directory.path(),
			output: text => {
				errors.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		},
	);
	await firstDelta.promise;
	expect(session.isStreaming).toBeTrue();
	expect(final).toBeUndefined();
	expect(partial).not.toContain("message 003");
	await running;
	await session.waitForIdle();
	expect(errors).toEqual([]);
	expect(Array.from(partial.match(/message \d{3}/g) ?? [])).toEqual(["message 001", "message 002", "message 003"]);
	expect(final?.stopReason).toBe("stop");
	expect(final?.usage.totalTokens).toBe(0);
	expect(idleAtEnd).toBeTrue();
	const restored = session.sessionManager.buildSessionContext().messages;
	expect(
		restored.some(
			message =>
				message.role === "assistant" &&
				message.content.some(block => block.type === "text" && block.text === partial),
		),
	).toBeTrue();
	expect(providerCalls).toBe(0);
	expect(credentialCalls).toBe(0);
});

it("uses normal session cancellation and rejects overlapping render runs", async () => {
	const firstDelta = Promise.withResolvers<void>();
	let final: AssistantMessage | undefined;
	session.subscribe(event => {
		if (event.type === "message_update") firstDelta.resolve();
		if (event.type === "message_end" && event.message.role === "assistant") final = event.message;
	});
	const running = session.runRenderTest({ lines: 100, delayMs: 5 });
	await firstDelta.promise;
	await expect(session.runRenderTest({ lines: 1, delayMs: 1 })).rejects.toThrow();
	await session.abort();
	await running;
	expect(session.isStreaming).toBeFalse();
	expect(final?.stopReason).toBe("aborted");
	expect(final?.content.some(block => block.type === "text" && block.text.includes("message 100"))).toBeFalse();
	expect(providerCalls).toBe(0);
	expect(credentialCalls).toBe(0);
});
