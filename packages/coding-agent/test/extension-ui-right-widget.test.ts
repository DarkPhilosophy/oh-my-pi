import { describe, expect, it } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../src/modes/types";

// Minimal context: setHookWidget / clearHookWidgets only touch the two hook
// containers, ui.requestRender, and setRightInfo.
function makeCtx(): { ctx: InteractiveModeContext; rightInfo: (string[][] | undefined)[] } {
	const rightInfo: (string[][] | undefined)[] = [];
	const ctx = {
		hookWidgetContainerAbove: new Container(),
		hookWidgetContainerBelow: new Container(),
		ui: { requestRender: () => {} },
		setRightInfo: (blocks: string[][] | undefined) => {
			rightInfo.push(blocks);
		},
	} as unknown as InteractiveModeContext;
	return { ctx, rightInfo };
}

describe("ExtensionUiController rightEditor widgets", () => {
	it("exposes each right widget as its own block (no merge)", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		// Equal height keeps insertion order, so the block split is unambiguous.
		c.setHookWidget("a", ["a1", "a2"], { placement: "rightEditor" });
		c.setHookWidget("b", ["b1", "b2"], { placement: "rightEditor" });

		expect(rightInfo.at(-1)).toEqual([
			["a1", "a2"],
			["b1", "b2"],
		]);
	});

	it("orders blocks by ascending height when no priority is set", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("tall", ["t1", "t2", "t3"], { placement: "rightEditor" });
		c.setHookWidget("short", ["s1"], { placement: "rightEditor" });

		// Shortest first so the small, always-present panels stay visible.
		expect(rightInfo.at(-1)).toEqual([["s1"], ["t1", "t2", "t3"]]);
	});

	it("places lower priority numbers first, overriding height", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("tall", ["t1", "t2", "t3"], { placement: "rightEditor", priority: 0 });
		c.setHookWidget("short", ["s1"], { placement: "rightEditor", priority: 1 });

		expect(rightInfo.at(-1)).toEqual([["t1", "t2", "t3"], ["s1"]]);
	});

	it("preserves right widget insertion order when an existing key updates", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("a", ["a1"], { placement: "rightEditor" });
		c.setHookWidget("b", ["b1"], { placement: "rightEditor" });
		c.setHookWidget("a", ["a2"], { placement: "rightEditor" });

		// Equal height -> insertion order (a before b) is preserved across update.
		expect(rightInfo.at(-1)).toEqual([["a2"], ["b1"]]);
	});

	it("does not cap right widget content before the compositor can place it", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		const lines = Array.from({ length: 15 }, (_, i) => `l${i}`);
		c.setHookWidget("big", lines, { placement: "rightEditor" });

		expect(rightInfo.at(-1)).toEqual([lines]);
	});

	it("clears right-side state when a key moves back to an inline placement", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("a", ["a1"], { placement: "rightEditor" });
		expect(rightInfo.at(-1)).toEqual([["a1"]]);

		// Same key, now aboveEditor → the stale right-side block must be cleared.
		c.setHookWidget("a", ["a1"], { placement: "aboveEditor" });
		expect(rightInfo.at(-1)).toBeUndefined();
	});

	it("clears right-side state when the key is removed (undefined content)", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("a", ["a1"], { placement: "rightEditor" });
		c.setHookWidget("a", undefined, { placement: "rightEditor" });
		expect(rightInfo.at(-1)).toBeUndefined();
	});

	it("clearHookWidgets drops all right-side blocks", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("a", ["a1"], { placement: "rightEditor" });
		c.clearHookWidgets();
		expect(rightInfo.at(-1)).toBeUndefined();
	});

	it("strips terminal-width padding from component-factory right widgets", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		// A width-aware component (like Text) pads its line to the full render width.
		// The stored block must reflect the real content width, not the terminal,
		// or compositeRightPanels would drop it as "too narrow".
		const factory = (() => ({
			render: (width: number) => [`hi${" ".repeat(Math.max(0, width - 2))}`],
			dispose() {},
		})) as unknown as Parameters<ExtensionUiController["setHookWidget"]>[1];
		c.setHookWidget("comp", factory, { placement: "rightEditor" });

		expect(rightInfo.at(-1)).toEqual([["hi"]]);
	});

	it("strips component right-widget padding before trailing SGR resets", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		const factory = (() => ({
			render: (width: number) => [`\x1b[31mhi${" ".repeat(Math.max(0, width - 2))}\x1b[0m`],
			dispose() {},
		})) as unknown as Parameters<ExtensionUiController["setHookWidget"]>[1];
		c.setHookWidget("styled", factory, { placement: "rightEditor" });

		expect(rightInfo.at(-1)).toEqual([["\x1b[31mhi\x1b[0m"]]);
	});
});
