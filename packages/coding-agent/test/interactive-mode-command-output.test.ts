import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Text } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

type Harness = {
	mode: InteractiveMode;
	tempDir: TempDir;
	setStreaming: (value: boolean) => void;
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

/** Transient chrome anchored above the editor (HUDs, banners, queued-command notice). */
function anchoredText(mode: InteractiveMode): string {
	return Bun.stripANSI(
		[
			mode.statusContainer,
			mode.todoContainer,
			mode.subagentContainer,
			mode.errorBannerContainer,
			mode.modelCycleContainer,
			mode.queuedCommandContainer,
		]
			.flatMap(container => container.render(120))
			.join("\n"),
	);
}

/** Non-blank rows of the queued-command notice alone (the container pads with a Spacer). */
function queuedNoticeRows(mode: InteractiveMode): string[] {
	return Bun.stripANSI(mode.queuedCommandContainer.render(120).join("\n"))
		.split("\n")
		.filter(row => row.trim().length > 0);
}

function transcriptText(mode: InteractiveMode): string {
	return mode.chatContainer.render(120).join("\n");
}

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(() => {
	harness?.mode.stop();
	harness?.tempDir.removeSync();
	harness = undefined;
	resetSettingsForTest();
});

describe("InteractiveMode mid-turn command output", () => {
	it("prints the panel after the response it was typed during, not before it", async () => {
		const { mode, setStreaming } = await createHarness();
		const streamed = new Text("response segment", 0, 0);
		mode.chatContainer.addChild(streamed);
		setStreaming(true);

		mode.presentCommandOutput(new Text("advisor panel", 1, 0));
		// Mounting straight away would insert above the block that started before
		// the command, making the panel read as if it had been typed earlier.
		expect(transcriptText(mode)).not.toContain("advisor panel");

		mode.mountQueuedCommandOutput();

		const children = mode.chatContainer.children;
		expect(children.indexOf(streamed)).toBeLessThan(children.length - 1);
		expect(transcriptText(mode)).toContain("advisor panel");
	});

	it("stays silent until the wait outlasts the notice delay, then shows one row and never a preview", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		vi.useFakeTimers();
		try {
			mode.presentCommandOutput(new Text("Claude 5 Hour: 62% used", 1, 0));
			// Most responses end in well under a second: a row that flashes by is
			// noise, so nothing is anchored while the delay is still pending.
			expect(queuedNoticeRows(mode)).toEqual([]);

			vi.advanceTimersByTime(2100);

			const anchored = queuedNoticeRows(mode);
			expect(anchored).toHaveLength(1);
			expect(anchored[0]).toContain("1 command output");
			// The report itself must never park above the prompt for the rest of a run.
			expect(anchoredText(mode)).not.toContain("Claude 5 Hour");

			mode.mountQueuedCommandOutput();
			expect(queuedNoticeRows(mode)).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps several queued panels in the order they were typed", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		vi.useFakeTimers();
		try {
			mode.presentCommandOutput([new Text("first panel", 1, 0), new Text("second panel", 1, 0)]);
			mode.presentCommandOutput(new Text("third panel", 1, 0));
			vi.advanceTimersByTime(2100);
			expect(anchoredText(mode)).toContain("2 command outputs");

			mode.mountQueuedCommandOutput();
		} finally {
			vi.useRealTimers();
		}

		const text = transcriptText(mode);
		expect(text.indexOf("first panel")).toBeLessThan(text.indexOf("second panel"));
		expect(text.indexOf("second panel")).toBeLessThan(text.indexOf("third panel"));
	});

	it("appends immediately when the agent is idle", async () => {
		const { mode } = await createHarness();

		mode.presentCommandOutput(new Text("usage panel", 1, 0));

		expect(transcriptText(mode)).toContain("usage panel");
		expect(anchoredText(mode)).not.toContain("command output");
	});

	it("drops queued output when the session is reset before the boundary", async () => {
		const { mode, setStreaming } = await createHarness();
		setStreaming(true);
		mode.presentCommandOutput(new Text("stale panel", 1, 0));

		mode.clearTransientSessionUi();
		mode.presentCommandOutput(new Text("fresh panel", 1, 0));
		mode.mountQueuedCommandOutput();

		const text = transcriptText(mode);
		expect(text).toContain("fresh panel");
		expect(text).not.toContain("stale panel");
	});
});
