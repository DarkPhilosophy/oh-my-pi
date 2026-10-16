import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as advisorFiles from "../src/advisor";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { createUsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

const COLS = 120;
const ROWS = 32;
const plain = (rows: readonly string[]): string[] => rows.map(row => Bun.stripANSI(row).trimEnd());

describe("command entry preserves completed tool frames", () => {
	let temp: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;
	let cards: ToolExecutionComponent[];
	let usageLine: string;
	let terminalWrites: string[];

	beforeAll(() => initTheme());
	beforeEach(async () => {
		resetSettingsForTest();
		temp = TempDir.createSync("command-entry-frames-");
		await Settings.init({ inMemory: true, cwd: temp.path() });
		auth = await AuthStorage.create(path.join(temp.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(auth);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(temp.path(), temp.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		vi.spyOn(session, "prompt").mockImplementation(async () => {
			throw new Error("Command-entry tests must not invoke a model");
		});
		vi.spyOn(advisorFiles, "resolveAdvisorConfigEditPath").mockImplementation(async scope =>
			path.join(temp.path(), scope, "WATCHDOG.yml"),
		);
		vi.spyOn(advisorFiles, "loadWatchdogConfigFile").mockImplementation(async () => ({
			advisors: [{ name: "Preview reviewer" }],
		}));
		vi.spyOn(advisorFiles, "saveWatchdogConfigFile").mockImplementation(async () => {
			throw new Error("Opening and closing the advisor editor must not save configuration");
		});
		terminal = new VirtualTerminal(COLS, ROWS);
		const composer = new Composer({ terminal });
		mode = new InteractiveMode(session, "test", undefined, () => {}, undefined, undefined, undefined, composer);
		cards = [];
		await mode.init({ suppressWelcomeIntro: true });
		void mode.getUserInput();
		await terminal.waitForRender();
		terminalWrites = [];
		const write = terminal.write.bind(terminal);
		vi.spyOn(terminal, "write").mockImplementation(data => {
			terminalWrites.push(data);
			write(data);
		});
		mode.editor.commandSuggestionsPopup = true;
	});

	afterEach(async () => {
		for (const card of cards ?? []) card.stopAnimation();
		vi.restoreAllMocks();
		if (session) Reflect.deleteProperty(session, "isStreaming");
		mode?.stop();
		await session?.dispose();
		auth?.close();
		temp?.removeSync();
		resetSettingsForTest();
	});

	function makeCard(name: string, args: Record<string, unknown>): ToolExecutionComponent {
		const card = new ToolExecutionComponent(name, args, { liveRegion: mode.chatContainer }, undefined, mode.ui);
		cards.push(card);
		card.setArgsComplete();
		card.setExecutionStarted();
		return card;
	}

	async function mountCompletedFrames(): Promise<void> {
		for (let index = 0; index < 40; index++) mode.chatContainer.addChild(new Text(`PRIOR_ROW_${index}`, 0, 0));
		const code = Array.from({ length: 26 }, (_, index) => `const EVAL_CODE_${index} = ${index};`).join("\n");
		const evalCard = makeCard("eval", { language: "js", code });
		const details: EvalToolDetails = {
			language: "js",
			languages: ["js"],
			cells: [
				{ index: 0, code, language: "js", output: "EVAL_RESULT_COMPLETE", status: "complete", statusEvents: [] },
			],
		};
		evalCard.updateResult({ content: [{ type: "text", text: "EVAL_RESULT_COMPLETE" }], details }, false);
		mode.chatContainer.addChild(evalCard);
		const bashCard = makeCard("bash", { command: "printf '%s\\n' BASH_COMMAND_ANCHOR" });
		bashCard.updateResult(
			{
				content: [{ type: "text", text: Array.from({ length: 51 }, (_, index) => `BASH_OUT_${index}`).join("\n") }],
				details: { exitCode: 0 },
			},
			false,
		);
		mode.chatContainer.addChild(bashCard);
		const usage = createUsageRowBlock(
			{
				input: 11,
				output: 7,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 18,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			1600,
			100,
		);
		usageLine = plain(usage.render(COLS)).find(row => row.length > 0)!;
		mode.chatContainer.addChild(usage);
		mode.ui.requestRender();
		await terminal.waitForRender(() => plain(terminal.getViewport()).includes(usageLine));
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
	}

	function expectCompletedFrames(): void {
		const rows = plain(terminal.getScrollBuffer());
		const bashMarkers = Array.from(rows.join("\n").match(/\bBASH_OUT_\d+\b/g) ?? []);
		expect(bashMarkers).toEqual(Array.from({ length: 10 }, (_, index) => `BASH_OUT_${index + 41}`));
		const lastOutput = rows.findIndex(row => /\bBASH_OUT_50\b/.test(row));
		const usage = rows.indexOf(usageLine);
		expect(usage).toBeGreaterThan(lastOutput);
		expect(rows.slice(lastOutput + 1, usage).some(row => /^[╰└]/u.test(row))).toBe(true);
		const evalResult = rows.findIndex(row => row.includes("EVAL_RESULT_COMPLETE"));
		const bashCommand = rows.findIndex(row => row.includes("BASH_COMMAND_ANCHOR"));
		expect(evalResult).toBeGreaterThanOrEqual(0);
		expect(bashCommand).toBeGreaterThan(evalResult);
		expect(rows.slice(evalResult + 1, bashCommand).some(row => /^[╰└]/u.test(row))).toBe(true);
		expect(rows.filter(row => row.includes("EVAL_RESULT_COMPLETE"))).toHaveLength(1);
		expect(terminalWrites.join("")).not.toContain("\x1b[3J");
	}

	it.each(["/advisor configure", "/adisor configure"])(
		"keeps Bash/Eval bodies and borders intact while typing and clearing %s",
		async command => {
			await mountCompletedFrames();
			expectCompletedFrames();
			terminal.sendInput("/");
			await terminal.waitForRender();
			terminal.sendInput(command.slice(1));
			await terminal.waitForRender(() => mode.editor.getText() === command);
			terminal.sendInput("\x15");
			await terminal.waitForRender(() => mode.editor.getText() === "");
			expectCompletedFrames();
			expect(session.prompt).not.toHaveBeenCalled();
		},
	);

	it("opens and closes the advisor overlay while streaming without cropping completed tool frames", async () => {
		await mountCompletedFrames();
		terminal.sendInput("/advisor configure");
		await terminal.waitForRender(() => mode.editor.getText() === "/advisor configure");
		terminal.sendInput("\r");
		await terminal.waitForRender(
			() => mode.ui.hasOverlay() && plain(terminal.getViewport()).some(row => row.includes("Global")),
		);
		expect(mode.ui.hasOverlay()).toBe(true);
		terminal.sendInput("\x1b");
		await terminal.waitForRender(() => !mode.ui.hasOverlay());
		expectCompletedFrames();
		expect(advisorFiles.saveWatchdogConfigFile).not.toHaveBeenCalled();
		expect(session.prompt).not.toHaveBeenCalled();
	});

	it("replaces a tall edit preview with both short error lines and a closed frame", async () => {
		for (let index = 0; index < 40; index++) mode.chatContainer.addChild(new Text(`EDIT_PRIOR_${index}`, 0, 0));
		const card = makeCard("edit", { path: "fixture.ts", edits: [{ loc: "1", content: "changed" }] });
		card.updateStreamPreview({
			files: [
				{
					path: "fixture.ts",
					diff: Array.from({ length: 40 }, (_, index) => `+${index + 1}|preview_${index}`).join("\n"),
				},
			],
			streaming: false,
		});
		mode.chatContainer.addChild(card);
		mode.ui.requestRender();
		await terminal.waitForRender();
		card.updateResult(
			{ content: [{ type: "text", text: "EDIT_ERROR_FIRST\nEDIT_ERROR_SECOND" }], isError: true },
			false,
		);
		mode.ui.requestRender();
		await terminal.waitForRender(() => plain(terminal.getViewport()).some(row => row.includes("EDIT_ERROR_SECOND")));
		const rows = plain(terminal.getViewport());
		const first = rows.findIndex(row => row.includes("EDIT_ERROR_FIRST"));
		const second = rows.findIndex(row => row.includes("EDIT_ERROR_SECOND"));
		expect(first).toBeGreaterThanOrEqual(0);
		expect(second).toBe(first + 1);
		expect(rows[second + 1]).toMatch(/^[╰└]/u);
		expect(rows.some(row => /preview_\d+/.test(row))).toBe(false);
		expect(terminalWrites.join("")).not.toContain("\x1b[3J");
	});
});
