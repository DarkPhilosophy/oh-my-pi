/**
 * Images attached during compaction must survive the compaction queue.
 *
 * Previously, typing a steer/follow-up message with a pending clipboard image
 * while the session was compacting was rejected outright ("Retry after it
 * completes to send images"). Now `queueCompactionMessage` carries the images,
 * and `flushCompactionQueue` forwards them to the session on delivery.
 *
 * Contracts defended here:
 *   - `queueCompactionMessage(text, mode, images)` stores the images on the
 *     queued entry and consumes the pending-image state (so the next message
 *     does not resend them).
 *   - On flush, the first queued prompt forwards its images via `session.prompt`.
 *   - On a `willRetry` flush, a queued follow-up forwards its images via
 *     `session.followUp` (the `#deliverQueuedMessage` path).
 *   - When `restoreQueuedMessagesToEditor` reinjects queued image-messages
 *     into a draft that already holds pending image(s), the merged text's
 *     `[Image #N]` markers stay aligned with the merged `pendingImages` order
 *     (#2531). Bug-by-design before that fix: queued markers (1..K) collided
 *     with the draft's leading markers and submit picked the wrong images.
 */

import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { CompactionQueuedMessage, InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { RestoredQueuedMessage } from "@oh-my-pi/pi-coding-agent/session/agent-session";

beforeAll(() => {
	initTheme();
});

type PromptOpts = { streamingBehavior?: "steer" | "followUp"; images?: ImageContent[] } | undefined;

function makeCtx(initialQueue: CompactionQueuedMessage[] = []) {
	const promptCalls: Array<{ text: string; opts: PromptOpts }> = [];
	const steerCalls: Array<{ text: string; images?: ImageContent[] }> = [];
	const followUpCalls: Array<{ text: string; images?: ImageContent[] }> = [];

	const session = {
		isStreaming: false,
		isCompacting: false,
		extensionRunner: undefined,
		customCommands: [] as Array<{ command: { name: string } }>,
		getQueuedMessages: () => ({ steering: [] as string[], followUp: [] as string[] }),
		clearQueue: () => ({ steering: [] as RestoredQueuedMessage[], followUp: [] as RestoredQueuedMessage[] }),
		prompt: mock(async (text: string, opts?: PromptOpts): Promise<void> => {
			promptCalls.push({ text, opts });
		}),
		steer: mock(async (text: string, images?: ImageContent[]): Promise<void> => {
			steerCalls.push({ text, images });
		}),
		followUp: mock(async (text: string, images?: ImageContent[]): Promise<void> => {
			followUpCalls.push({ text, images });
		}),
	};

	let editorText = "";

	const ctx = {
		session,
		viewSession: session,
		compactionQueuedMessages: [...initialQueue],
		pendingImages: [] as ImageContent[],
		pendingImageLinks: [] as (string | undefined)[],
		pendingMessagesContainer: { clear: () => {}, addChild: () => {}, removeChild: () => {} },
		editor: {
			addToHistory: () => {},
			setText: (text: string) => {
				editorText = text;
			},
			getText: () => editorText,
			imageLinks: undefined as (string | undefined)[] | undefined,
		},
		keybindings: { getDisplayString: () => "Alt+Up" },
		fileSlashCommands: new Set<string>(),
		locallySubmittedUserSignatures: new Set<string>(),
		isKnownSlashCommand: (text: string) => text.startsWith("/"),
		recordLocalSubmission: () => () => {},
		async withLocalSubmission<T>(_text: string, fn: () => Promise<T>): Promise<T> {
			return await fn();
		},
		updatePendingMessagesDisplay: () => {},
		showError: () => {},
		showStatus: () => {},
	} as unknown as InteractiveModeContext;

	return { ctx, session, promptCalls, steerCalls, followUpCalls };
}

const img = (data: string): ImageContent => ({ type: "image", mimeType: "image/png", data });

describe("compaction queue image forwarding", () => {
	test("queueCompactionMessage stores images and consumes pending-image state", () => {
		const image = img("aGVsbG8=");
		const { ctx } = makeCtx();
		ctx.pendingImages = [image];
		ctx.pendingImageLinks = ["clipboard"];
		ctx.editor.imageLinks = ["clipboard"];

		new UiHelpers(ctx).queueCompactionMessage("look at this screenshot", "steer", [image]);

		expect(ctx.compactionQueuedMessages).toEqual([
			{ text: "look at this screenshot", mode: "steer", images: [image] },
		]);
		// Pending state is consumed so the next message does not resend the image.
		expect(ctx.pendingImages).toEqual([]);
		expect(ctx.pendingImageLinks).toEqual([]);
		expect(ctx.editor.imageLinks).toBeUndefined();
	});

	test("empty image list is normalized to undefined on the queued entry", () => {
		const { ctx } = makeCtx();
		new UiHelpers(ctx).queueCompactionMessage("no images here", "followUp", []);
		expect(ctx.compactionQueuedMessages).toEqual([{ text: "no images here", mode: "followUp", images: undefined }]);
	});

	test("flush forwards the first queued prompt's images via session.prompt", async () => {
		const image = img("d29ybGQ=");
		const { ctx, promptCalls } = makeCtx([{ text: "describe this", mode: "steer", images: [image] }]);

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });
		await Promise.resolve();
		await Promise.resolve();

		expect(promptCalls).toHaveLength(1);
		expect(promptCalls[0].text).toBe("describe this");
		expect(promptCalls[0].opts?.images).toEqual([image]);
	});

	test("willRetry flush forwards a follow-up's images via session.followUp", async () => {
		const image = img("Zm9v");
		const { ctx, followUpCalls } = makeCtx([{ text: "and this one", mode: "followUp", images: [image] }]);

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: true });

		expect(followUpCalls).toEqual([{ text: "and this one", images: [image] }]);
	});
});

describe("compaction queue Alt+Up restore", () => {
	test("restoreQueuedMessagesToEditor drains a compaction-queued skill", () => {
		const { ctx } = makeCtx([{ text: "/skill:foo bar", mode: "followUp", images: undefined }]);
		const restored = new InputController(ctx).restoreQueuedMessagesToEditor();
		expect(restored).toBe(1);
		expect(ctx.editor.getText()).toBe("/skill:foo bar");
		expect(ctx.compactionQueuedMessages).toEqual([]);
	});

	test("restored compaction images return to the pending-image buffer", () => {
		const image = img("YmF6");
		const { ctx } = makeCtx([{ text: "look", mode: "steer", images: [image] }]);
		const restored = new InputController(ctx).restoreQueuedMessagesToEditor();
		expect(restored).toBe(1);
		expect(ctx.pendingImages).toEqual([image]);
	});

	test("session and compaction queues restore in pending-bar order", () => {
		const { ctx, session } = makeCtx([
			{ text: "compaction steer", mode: "steer", images: undefined },
			{ text: "compaction followup", mode: "followUp", images: undefined },
		]);
		session.clearQueue = () => ({
			steering: [{ text: "session steer" }],
			followUp: [{ text: "session followup" }],
		});
		const restored = new InputController(ctx).restoreQueuedMessagesToEditor();
		expect(restored).toBe(4);
		expect(ctx.editor.getText()).toBe("session steer\n\ncompaction steer\n\nsession followup\n\ncompaction followup");
	});
});

/**
 * Restore path: when the editor draft already holds pending image(s) and a
 * queued image-message is restored (Alt+Up, Esc-abort, …), the merged text's
 * `[Image #N]` markers must still map positionally to `pendingImages`. The
 * old code prepended queued text but appended queued images, so the queued
 * markers (1..K) collided with the draft markers (1..M) and resolved to the
 * wrong images at submit time.
 */
describe("restoreQueuedMessagesToEditor image marker alignment", () => {
	function makeRestoreCtx(opts: {
		draftText?: string;
		draftImages?: ImageContent[];
		queued?: { text: string; images?: ImageContent[] }[];
	}) {
		let editorText = opts.draftText ?? "";
		const editor = {
			setText: (text: string) => {
				editorText = text;
			},
			getText: () => editorText,
			addToHistory: () => {},
			imageLinks: undefined as (string | undefined)[] | undefined,
		};
		const session = {
			clearQueue: mock(() => ({ steering: opts.queued ?? [], followUp: [] })),
			abort: mock(async () => {}),
		};
		const ctx = {
			session,
			viewSession: session,
			editor,
			pendingImages: opts.draftImages ? [...opts.draftImages] : ([] as ImageContent[]),
			pendingImageLinks: opts.draftImages ? opts.draftImages.map(() => undefined) : ([] as (string | undefined)[]),
			compactionQueuedMessages: [],
			locallySubmittedUserSignatures: new Set<string>(),
			updatePendingMessagesDisplay: () => {},
		} as unknown as InteractiveModeContext;
		return { ctx, editor };
	}

	test("renumbers queued markers when the draft already holds a pending image", () => {
		const draftImg = img("ZHJhZnQ=");
		const queuedImg = img("cXVldWVk");
		const { ctx, editor } = makeRestoreCtx({
			draftText: "[Image #1] draft text",
			draftImages: [draftImg],
			queued: [{ text: "[Image #1] queued text", images: [queuedImg] }],
		});

		const restored = new InputController(ctx).restoreQueuedMessagesToEditor();

		// The draft marker stays at #1 (its image kept slot 0); the queued
		// marker is bumped to #2 because the queued image is appended at slot 1.
		expect(restored).toBe(1);
		expect(editor.getText()).toBe("[Image #2] queued text\n\n[Image #1] draft text");
		expect(ctx.pendingImages).toEqual([draftImg, queuedImg]);
		// Marker → image positional mapping after restore.
		expect(ctx.pendingImages[0]).toBe(draftImg); // matches [Image #1]
		expect(ctx.pendingImages[1]).toBe(queuedImg); // matches [Image #2]
	});

	test("preserves the WxH metadata tail when renumbering", () => {
		const draftImg = img("ZHJhZnQ=");
		const queuedImg = img("cXVldWVk");
		const { ctx, editor } = makeRestoreCtx({
			draftText: "[Image #1, 100x100]",
			draftImages: [draftImg],
			queued: [{ text: "look [Image #1, 800x600] now", images: [queuedImg] }],
		});

		new InputController(ctx).restoreQueuedMessagesToEditor();

		expect(editor.getText()).toBe("look [Image #2, 800x600] now\n\n[Image #1, 100x100]");
	});

	test("accumulates the offset across multiple queued image-messages", () => {
		const draftImg = img("ZHJhZnQ=");
		const queued1 = img("cTE=");
		const queued2a = img("cTJh");
		const queued2b = img("cTJi");
		const { ctx, editor } = makeRestoreCtx({
			draftText: "see [Image #1]",
			draftImages: [draftImg],
			queued: [
				{ text: "first [Image #1]", images: [queued1] },
				{ text: "second [Image #1] and [Image #2]", images: [queued2a, queued2b] },
			],
		});

		new InputController(ctx).restoreQueuedMessagesToEditor();

		// msg1 markers shift by 1 (draft images), msg2 markers shift by 1+1=2.
		expect(editor.getText()).toBe("first [Image #2]\n\nsecond [Image #3] and [Image #4]\n\nsee [Image #1]");
		expect(ctx.pendingImages).toEqual([draftImg, queued1, queued2a, queued2b]);
	});

	test("leaves the queued text untouched when the draft has no pending images", () => {
		const queuedImg = img("cXVldWVk");
		const { ctx, editor } = makeRestoreCtx({
			queued: [{ text: "[Image #1] queued", images: [queuedImg] }],
		});

		new InputController(ctx).restoreQueuedMessagesToEditor();

		expect(editor.getText()).toBe("[Image #1] queued");
		expect(ctx.pendingImages).toEqual([queuedImg]);
	});
});

describe("compaction queue coalescing keeps local-submit signatures exact (VyEt)", () => {
	type OnQueued = (text: string, imageCount: number, replacedText?: string) => void;

	test("two plain compaction steers that coalesce leave only the merged signature", async () => {
		const { ctx, session } = makeCtx([
			{ text: "a", mode: "steer" } as CompactionQueuedMessage,
			{ text: "b", mode: "steer" } as CompactionQueuedMessage,
		]);
		const sigs = ctx.locallySubmittedUserSignatures;
		// Real signature bookkeeping (the production harness stub is a no-op).
		(ctx as unknown as { recordLocalSubmission: (t: string, c?: number) => () => void }).recordLocalSubmission = (
			text: string,
			imageCount = 0,
		) => {
			const sig = `${text}\u0000${imageCount}`;
			sigs.add(sig);
			return () => sigs.delete(sig);
		};
		// Simulate the queue coalescing the second message into the first: prompt/steer
		// report the running merge (and the prior tail it replaced) through onQueued, the
		// way #queueUserMessage does on a real merge.
		let tail: string | undefined;
		session.prompt = mock(async (text: string, opts?: PromptOpts & { onQueued?: OnQueued }) => {
			tail = text;
			opts?.onQueued?.(text, 0, undefined);
		}) as typeof session.prompt;
		session.steer = mock(async (text: string, _images?: ImageContent[], onQueued?: OnQueued) => {
			const replaced = tail;
			tail = replaced === undefined ? text : `${replaced}\n${text}`;
			onQueued?.(tail, 0, replaced);
		}) as typeof session.steer;

		await new UiHelpers(ctx).flushCompactionQueue({ willRetry: false });

		// Only the delivered merged message stays marked local; the per-message "a"/"b"
		// signatures are gone, so a later identical line is not falsely treated as local.
		expect([...sigs]).toEqual(["a\nb\u00000"]);
	});
});

describe("pending queue collapse/expand display", () => {
	function displayCtx(opts: { collapseLines: number; expanded: boolean; steering: string[] }) {
		const rows: string[] = [];
		const ctx = {
			pendingMessagesContainer: {
				clear: () => {},
				addChild: (c: unknown) => {
					// Components render their content; join the produced lines so assertions can
					// match the visible text (TruncatedText keeps its text private). Spacer renders
					// blank padding rows, which the body filter ignores.
					const r = c as { render?: (w: number) => readonly string[] };
					if (typeof r.render === "function") rows.push(r.render(120).join(""));
				},
			},
			viewSession: { getQueuedMessages: () => ({ steering: opts.steering, followUp: [] }) },
			compactionQueuedMessages: [],
			pendingQueueExpanded: opts.expanded,
			settings: { get: (k: string) => (k === "pendingQueueCollapseLines" ? opts.collapseLines : undefined) },
			keybindings: { getDisplayString: (id: string) => (id === "app.message.expandQueue" ? "Alt+O" : "Alt+Up") },
		} as unknown as InteractiveModeContext;
		new UiHelpers(ctx).updatePendingMessagesDisplay();
		return rows;
	}

	const sevenLine = Array.from({ length: 7 }, (_, i) => `line${i + 1}`).join("\n");
	// Drop the leading Spacer's blank row and the trailing hint row (`Up to restore …`),
	// leaving message rows.
	const bodyRows = (rows: string[]) => rows.filter(r => r.trim() !== "" && !r.includes("to restore"));

	test("collapsed shows a label row then N preview lines with a (+M) remainder", () => {
		const rows = displayCtx({ collapseLines: 5, expanded: false, steering: [sevenLine] });
		const body = bodyRows(rows);
		expect(body).toHaveLength(6); // `Steer:` label row + 5 of 7 lines
		expect(body[0]).toContain("Steer:");
		expect(body[0]).not.toContain("line1"); // label is on its own row
		expect(body[1]).toContain("line1");
		expect(body[5]).toContain("line5 (+2)"); // remaining 2 lines folded onto the last shown row
		expect(rows.some(r => r.includes("Alt+O to expand"))).toBe(true);
	});

	test("expanded shows the label row then every line in full with no (+M)", () => {
		const rows = displayCtx({ collapseLines: 5, expanded: true, steering: [sevenLine] });
		const body = bodyRows(rows);
		expect(body).toHaveLength(8); // `Steer:` label row + all 7 lines
		expect(body[0]).toContain("Steer:");
		expect(body[7]).toContain("line7");
		expect(body.some(r => r.includes("(+"))).toBe(false);
		expect(rows.some(r => r.includes("Alt+O to collapse"))).toBe(true);
	});

	test("an entry within the preview budget is not truncated and shows no expand hint", () => {
		const rows = displayCtx({ collapseLines: 5, expanded: false, steering: ["only one line"] });
		const body = bodyRows(rows);
		expect(body[0]).toContain("Steer:");
		expect(body[1]).toContain("only one line");
		// The base hint names the gesture that always works (Up on empty editor),
		// not the terminal-dependent Alt+Up keybinding, and offers no Alt+O when nothing
		// is truncatable.
		const hintRow = rows.find(r => r.includes("to restore"));
		expect(hintRow).toContain("Up to restore");
		expect(rows.some(r => r.includes("Alt+O"))).toBe(false);
	});
});
