/** A model-requested context rollover must not leave live blocks that hold back the rest of the turn. */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { InteractiveMode } from "../src/modes/interactive-mode";
import { AgentSession } from "../src/session/agent-session";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import type { Tool, ToolSession } from "../src/tools";
import { BUILTIN_TOOL_NAMES } from "../src/tools/builtin-names";
import { ContextNotesTool, NewContextTool } from "../src/tools/context-notes";
import { GrepTool } from "../src/tools/grep";
import { ReadTool } from "../src/tools/read";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let directory: TempDir;
let session: AgentSession;
let mode: InteractiveMode;
let terminal: VirtualTerminal;
const authStorage = createInMemoryAuthStorage();
authStorage.keys.setRuntime("mock", "test-key");

async function start(responses: MockHandler[]): Promise<Tool[]> {
	const mock = createMockModel({ responses });
	const manager = SessionManager.inMemory(directory.path());
	const settings = Settings.isolated({
		"startup.quiet": true,
		"compaction.experimentalContextManagement": true,
		"compaction.enabled": true,
		"compaction.keepRecentTokens": 128,
		"compaction.midTurnEnabled": false,
	});
	const toolSession: ToolSession = {
		cwd: directory.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => manager.getSessionId(),
		getSessionSpawns: () => "*",
		sessionManager: manager,
		settings,
		onContextNotesSaved: entryId => session?.noteContextNotesSaved(entryId),
	};
	const tools: Tool[] = [
		new ReadTool(toolSession),
		new GrepTool(toolSession),
		new ContextNotesTool(toolSession),
		new NewContextTool(toolSession),
	];
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: ["test"], tools, messages: [] },
		getApiKey: () => "test-key",
		convertToLlm,
		streamFn: mock.stream,
	});
	session = new AgentSession({
		agent,
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(authStorage),
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		builtInToolNames: BUILTIN_TOOL_NAMES,
	});
	await session.setActiveToolsByName(tools.map(tool => tool.name));
	terminal = new VirtualTerminal(110, 20, 10_000);
	const composer = new Composer({ terminal, preferences: { quiet: true } });
	mode = new InteractiveMode(session, "test", () => {}, undefined, undefined, undefined, composer);
	vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	await mode.init({ suppressWelcomeIntro: true });
	return tools;
}

beforeEach(async () => {
	directory = await TempDir.create("omp-rollover-retire-");
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: directory.path(), agentDir: directory.path() });
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
});

afterEach(async () => {
	await session?.abort();
	mode?.stop();
	await session?.dispose();
	await directory?.remove();
	vi.restoreAllMocks();
	resetSettingsForTest();
});

function unfinalized(): string[] {
	return mode.chatContainer.children
		.filter(child => (child as { isTranscriptBlockFinalized?(): boolean }).isTranscriptBlockFinalized?.() === false)
		.map(child => child.constructor.name);
}

const FILE_NAME = "after-rollover.txt";
const LAG_POINTS = ["none", "next-turn", "mid-tool"] as const;

/**
 * A rollover whose end event the UI handles after the agent moved on:
 * "next-turn" lets the post-rollover grep finish first, "mid-tool" holds the
 * grep running while the rebuild replays the session.
 */
it.each(LAG_POINTS)(
	"draws each post-rollover tool once and settles it before the turn ends (UI lag: %s)",
	async lagPoint => {
		await Bun.write(
			directory.join(FILE_NAME),
			Array.from({ length: 60 }, (_, row) => `AFTER_ROLLOVER_ROW_${row}`).join("\n"),
		);
		const grepStarted = Promise.withResolvers<void>();
		const grepRelease = Promise.withResolvers<void>();
		const finalReached = Promise.withResolvers<void>();
		const finalRelease = Promise.withResolvers<void>();
		const tools = await start([
			{
				content: [
					"Exploring the project. ".repeat(200),
					{ type: "toolCall", name: "read", arguments: { path: `${FILE_NAME}:1-20` } },
				],
			},
			{ content: [{ type: "toolCall", name: "context_notes", arguments: { text: "checkpoint" } }] },
			{
				content: [
					{ type: "toolCall", name: "new_context", arguments: {} },
					{ type: "toolCall", name: "read", arguments: { path: `${FILE_NAME}:21-30` } },
				],
			},
			{
				content: [
					"Searching after the rollover.",
					{ type: "toolCall", name: "grep", arguments: { pattern: "AFTER_ROLLOVER_ROW_", path: FILE_NAME } },
				],
			},
			async () => {
				finalReached.resolve();
				await finalRelease.promise;
				return { content: ["FINAL_REPLY"] };
			},
		]);
		const grep = tools.find(tool => tool.name === "grep")!;
		const execute = grep.execute.bind(grep);
		vi.spyOn(grep, "execute").mockImplementation(async (...args) => {
			grepStarted.resolve();
			if (lagPoint === "mid-tool") await grepRelease.promise;
			return execute(...args);
		});
		if (lagPoint !== "none") {
			// The UI drains session events serially and can run behind the agent
			// (a blocked loop): the rollover's rebuild then runs while the session
			// already holds the next turn, whose queued events still have to draw it.
			const handle = mode.eventController.handleEvent.bind(mode.eventController);
			vi.spyOn(mode.eventController, "handleEvent").mockImplementation(async event => {
				if (event.type === "auto_compaction_end") {
					await (lagPoint === "mid-tool" ? grepStarted.promise : finalReached.promise);
				}
				return handle(event);
			});
		}
		mode.setToolsExpanded(true);
		const running = session.prompt("Work, roll over, then keep going.");
		try {
			if (lagPoint === "mid-tool") {
				await grepStarted.promise;
				await settle();
				grepRelease.resolve();
			}
			await finalReached.promise;
			await settle();
			const screen = terminal
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row))
				.join("\n");
			expect(screen.split("Grep: AFTER_ROLLOVER_ROW_").length - 1).toBe(1);
			expect(unfinalized()).toEqual([]);
		} finally {
			grepRelease.resolve();
			finalRelease.resolve();
			await running;
			await session.waitForIdle();
		}
	},
	30_000,
);

async function settle(): Promise<void> {
	for (let pass = 0; pass < 5; pass++) {
		await terminal.waitForRender();
		await Bun.sleep(20);
	}
}
