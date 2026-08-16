import { afterAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

type Harness = {
	mode: InteractiveMode;
	tempDir: TempDir;
	setStreaming: (value: boolean) => void;
};

type LiveText = Text & {
	isTranscriptBlockFinalized: () => boolean;
};

let harness: Harness | undefined;

async function createHarness(): Promise<Harness> {
	if (harness) {
		harness.setStreaming(false);
		harness.mode.clearTransientSessionUi();
		harness.mode.chatContainer.disposeChildren();
		return harness;
	}

	const tempDir = TempDir.createSync("@pi-command-output-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
	const sessionManager = SessionManager.inMemory(tempDir.path());
	await sessionManager.setSessionName("Command output", "user");
	let streaming = false;
	const session = {
		sessionManager,
		settings,
		agent: { state: { tools: [] }, metadataForProvider: () => undefined },
		customCommands: [],
		skills: [],
		autoCompactionEnabled: true,
		messages: [],
		systemPrompt: [],
		state: { model: undefined },
		model: undefined,
		thinkingLevel: undefined,
		get isStreaming() {
			return streaming;
		},
	} as unknown as AgentSession;
	const mode = new InteractiveMode(session, "test");
	harness = {
		mode,
		tempDir,
		setStreaming: (value: boolean) => {
			streaming = value;
		},
	};
	return harness;
}

function addLiveReply(mode: InteractiveMode): LiveText {
	const live = new Text("agent is streaming", 0, 0) as LiveText;
	live.isTranscriptBlockFinalized = () => false;
	mode.chatContainer.addChild(live);
	return live;
}

afterAll(() => {
	harness?.mode.stop();
	harness?.tempDir.removeSync();
	harness = undefined;
	resetSettingsForTest();
});

describe("InteractiveMode command output ordering", () => {
	it("inserts every component of one command before the live block in original order", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		const live = addLiveReply(mode);
		const spacer = new Text("command spacer", 0, 0);
		const panel = new Text("usage panel", 0, 0);

		mode.presentCommandOutput([spacer, panel]);

		expect(mode.chatContainer.children).toEqual([spacer, panel, live]);
	});

	it("keeps separate mid-turn command outputs chronological above the same live block", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		const live = addLiveReply(mode);
		const usage = new Text("usage panel", 0, 0);
		const jobs = new Text("jobs panel", 0, 0);

		mode.presentCommandOutput(usage);
		mode.presentCommandOutput(jobs);

		expect(mode.chatContainer.children).toEqual([usage, jobs, live]);
	});
});
