import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { Composer } from "../src/modes/composer";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

let directory: TempDir;
let auth: AuthStorage;
let session: AgentSession;
let mode: InteractiveMode;
let terminal: VirtualTerminal;
let providerCalls: number;
let credentialCalls: number;
let beforeAssistantEnd: (() => Promise<void>) | undefined;

beforeEach(async () => {
	directory = await TempDir.create("omp-render-test-");
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: directory.path(), agentDir: directory.path() });
	auth = await AuthStorage.create(":memory:");
	providerCalls = 0;
	credentialCalls = 0;
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		initialState: { model, tools: [] },
		getApiKey: () => {
			credentialCalls++;
			throw new Error("Render requested credentials");
		},
		streamFn: () => {
			providerCalls++;
			throw new Error("Render contacted a provider");
		},
	});
	beforeAssistantEnd = undefined;
	const sessionManager = SessionManager.inMemory(directory.path());
	const modelRegistry = new ModelRegistry(auth, directory.join("models.yml"));
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		api => {
			api.on("message_end", async event => {
				if (event.message.role === "assistant") await beforeAssistantEnd?.();
			});
		},
		directory.path(),
		new EventBus(),
		runtime,
		"render-event-ordering",
	);
	session = new AgentSession({
		agent,
		sessionManager,
		builtInToolNames: ["read", "edit", "todo", "ask", "bash", "hub"],
		settings: Settings.isolated({
			"startup.quiet": true,
			"compaction.enabled": false,
			"read.toolResultPreview": true,
		}),
		modelRegistry,
		extensionRunner: new ExtensionRunner([extension], runtime, directory.path(), sessionManager, modelRegistry),
	});
	terminal = new VirtualTerminal(110, 20, 10_000);
	const composer = new Composer({ terminal, preferences: { quiet: true } });
	mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
	vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	await mode.init({ suppressWelcomeIntro: true });
});

afterEach(async () => {
	await session?.abort();
	mode?.stop();
	await session?.dispose();
	auth?.close();
	await directory?.remove();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

it("captures live card transitions", async () => {
	terminal.resize(110, 60);
	const frames = [];
	let plan;
	const render = Composer.prototype.renderFrame;
	vi.spyOn(Composer.prototype, "renderFrame").mockImplementation(function (size) {
		const result = render.call(this, size);
		plan = {
			viewport: [...result.viewport],
			history: result.history ? { ...result.history, rows: [...result.history.rows] } : undefined,
			borrowed: result.borrowedViewportRows,
			expansion: result.viewportExpansionRows,
		};
		return result;
	});
	const write = terminal.write.bind(terminal);
	vi.spyOn(terminal, "write").mockImplementation(data => {
		write(data);
		frames.push({ plan, data, position: terminal.getBufferPosition(), tape: terminal.getScrollBuffer() });
	});
	await session.runRenderTest({ repeat: 1, delayMs: 5, scenario: "job" }, mode.getToolUIContext());
	await session.waitForIdle();
	await terminal.waitForRender();
	await Bun.write("/tmp/omp-live-card-frames.json", JSON.stringify(frames));
}, 180000);
