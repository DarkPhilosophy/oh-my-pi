import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Regression for issue #2372 — pressing Ctrl+T (or any other rebuild path)
 * during the pre-streaming window after a user submission must not erase the
 * optimistically-rendered user message. `startPendingSubmission` paints the
 * user's message before `session.prompt(...)` has appended it to session
 * entries; a `rebuildChatFromMessages()` in that window used to wipe it
 * because `buildTranscriptSessionContext()` has no record of it yet.
 */
describe("issue #2372 pre-streaming chat rebuild preserves optimistic submission", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-2372-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("keeps the optimistic user message in chat after rebuildChatFromMessages before streaming starts", () => {
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "hello world" });
		expect(mode.optimisticUserMessageSignature).toBe("hello world\u00000");
		expect(addMessageSpy).toHaveBeenCalledTimes(1);
		expect(mode.chatContainer.children.length).toBeGreaterThan(0);

		// Pre-streaming rebuild: no streamingComponent yet, message is NOT in
		// session entries yet, signature is still set.
		expect(mode.streamingComponent).toBeUndefined();
		mode.rebuildChatFromMessages();
		// Signature stays set until EventController processes user message_start.
		expect(mode.optimisticUserMessageSignature).toBe("hello world\u00000");
		// The replay must have re-rendered the user message: total addMessageToChat
		// calls == initial optimistic add + 1 replay during rebuild.
		expect(addMessageSpy).toHaveBeenCalledTimes(2);
		const replayCall = addMessageSpy.mock.calls[1]?.[0];
		expect(replayCall).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "hello world" }],
			attribution: "user",
		});
		// Chat container is non-empty (the optimistic user message is back).
		expect(mode.chatContainer.children.length).toBeGreaterThan(0);
	});

	it("does not duplicate the user message once message_start has cleared the optimistic signature", () => {
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "hello again" });
		expect(addMessageSpy).toHaveBeenCalledTimes(1);

		// Simulate EventController#handleMessageStart having confirmed the user
		// message: signature is cleared, real session entry exists in the
		// transcript path. `#pendingSubmittedInput` may still be alive (we are
		// streaming) but the replay must NOT trigger.
		mode.optimisticUserMessageSignature = undefined;

		mode.rebuildChatFromMessages();

		// Only the initial optimistic add — no replay duplication.
		expect(addMessageSpy).toHaveBeenCalledTimes(1);
	});

	it("does not replay after the submission is cancelled", () => {
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		mode.startPendingSubmission({ text: "cancel me" });
		expect(mode.optimisticUserMessageSignature).toBe("cancel me\u00000");
		mode.cancelPendingSubmission();

		// `cancelPendingSubmission` already rebuilds; after that, an explicit
		// rebuild must not resurrect the cancelled message.
		const callsAfterCancel = addMessageSpy.mock.calls.length;
		mode.rebuildChatFromMessages();
		expect(addMessageSpy).toHaveBeenCalledTimes(callsAfterCancel);
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
	});

	it("drops the stale optimistic bubble when a queue coalesce swallows the rendered send", () => {
		// Repro for the PR #2890 Codex P2: an idle queued-message drain can coalesce a
		// just-rendered optimistic send ("Line2") into the pending tail ("Line1") before the
		// submit path reaches prompt(). The incoming message_start then carries the merged
		// "Line1\nLine2", which no longer matches the stale "Line2" optimistic signature — so
		// without the fix EventController appends a second bubble and the line shows twice.
		const addMessageSpy = vi.spyOn(mode, "addMessageToChat");

		// "Line2" was optimistically rendered by the normal submit path.
		mode.startPendingSubmission({ text: "Line2" });
		expect(mode.optimisticUserMessageSignature).toBe("Line2\u00000");
		expect(addMessageSpy).toHaveBeenCalledTimes(1);

		// The merge swallowed "Line2" into "Line1\nLine2" (replacing the "Line1" tail).
		session.onLocalQueueCoalesced?.("Line2", "Line1\nLine2", "Line1", 0);

		// The already-rendered "Line2" bubble must be gone immediately: the helper surgically
		// removes the optimistic bubble's own components from chatContainer (no full rebuild).
		// Pre-streaming there is nothing else in chat, so it is empty.
		expect(mode.chatContainer.children.length).toBe(0);

		// Optimistic state for the swallowed send is gone, so the merged message_start
		// will be appended once (wasOptimistic === false) with the full correct text.
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
		// The merged text is recorded as a local submission so message_start does not
		// clobber an in-progress editor draft.
		expect(mode.locallySubmittedUserSignatures.has("Line1\nLine2\u00000")).toBe(true);
		expect(mode.locallySubmittedUserSignatures.has("Line2\u00000")).toBe(false);

		// A later rebuild must not resurrect the stale "Line2" bubble.
		const callsAfterDrop = addMessageSpy.mock.calls.length;
		mode.rebuildChatFromMessages();
		expect(addMessageSpy).toHaveBeenCalledTimes(callsAfterDrop);
	});

	it("keeps the active streaming block attached when dropping the optimistic bubble mid-stream", () => {
		// Repro for the PR #2890 Codex P2 follow-up: a coalesce can fire while another turn is
		// already streaming (an idle drain races the submit path). The active assistant block is
		// not persisted until message_end, so a full chatContainer rebuild would detach the
		// component streamingComponent points at, and later deltas would update an orphaned,
		// invisible block. The drop must remove ONLY the optimistic bubble, leaving the live
		// stream attached.
		mode.startPendingSubmission({ text: "Line2" });
		const optimisticCount = mode.chatContainer.children.length;
		expect(optimisticCount).toBeGreaterThan(0);

		// Simulate an assistant turn already streaming: a live block in chatContainer that
		// streamingComponent points at (not yet persisted to session entries).
		const streamingBlock = mode.addMessageToChat({
			role: "assistant",
			content: [{ type: "text", text: "partial answer" }],
			timestamp: Date.now(),
		} as unknown as Parameters<typeof mode.addMessageToChat>[0])[0];
		mode.streamingComponent = streamingBlock as unknown as typeof mode.streamingComponent;
		expect(mode.chatContainer.children).toContain(streamingBlock);

		// Coalesce swallows the optimistic "Line2" while the stream is live.
		session.onLocalQueueCoalesced?.("Line2", "Line1\nLine2", "Line1", 0);

		// The live streaming block is still attached (would be detached by a rebuild),
		// while the optimistic bubble's own components are gone.
		expect(mode.chatContainer.children).toContain(streamingBlock);
		expect(mode.streamingComponent as unknown).toBe(streamingBlock);
		expect(mode.optimisticUserMessageSignature).toBeUndefined();
	});
});
