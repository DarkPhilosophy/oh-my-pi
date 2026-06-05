import { describe, expect, it } from "bun:test";
import { Container } from "@oh-my-pi/pi-tui";
import { ExtensionUiController } from "../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../src/modes/types";

// Minimal context: setHookWidget / clearHookWidgets only touch the two hook
// containers, ui.requestRender, and setRightInfo.
function makeCtx(): { ctx: InteractiveModeContext; rightInfo: (string[] | undefined)[] } {
	const rightInfo: (string[] | undefined)[] = [];
	const ctx = {
		hookWidgetContainerAbove: new Container(),
		hookWidgetContainerBelow: new Container(),
		ui: { requestRender: () => {} },
		setRightInfo: (lines: string[] | undefined) => {
			rightInfo.push(lines);
		},
	} as unknown as InteractiveModeContext;
	return { ctx, rightInfo };
}

describe("ExtensionUiController rightEditor widgets", () => {
	it("merges multiple right widget keys with a blank separator", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("a", ["a1", "a2"], { placement: "rightEditor" });
		c.setHookWidget("b", ["b1"], { placement: "rightEditor" });

		expect(rightInfo.at(-1)).toEqual(["a1", "a2", "", "b1"]);
	});

	it("preserves right widget order when an existing key updates", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("a", ["a1"], { placement: "rightEditor" });
		c.setHookWidget("b", ["b1"], { placement: "rightEditor" });
		c.setHookWidget("a", ["a2"], { placement: "rightEditor" });

		expect(rightInfo.at(-1)).toEqual(["a2", "", "b1"]);
	});

	it("does not cap right widget content before the compositor can place it", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		const lines = Array.from({ length: 15 }, (_, i) => `l${i}`);
		c.setHookWidget("big", lines, { placement: "rightEditor" });

		expect(rightInfo.at(-1)).toEqual(lines);
	});

	it("clears right-side state when a key moves back to an inline placement", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("a", ["a1"], { placement: "rightEditor" });
		expect(rightInfo.at(-1)).toEqual(["a1"]);

		// Same key, now aboveEditor → the stale right-side lines must be cleared.
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

	it("clearHookWidgets drops all right-side lines", () => {
		const { ctx, rightInfo } = makeCtx();
		const c = new ExtensionUiController(ctx);

		c.setHookWidget("a", ["a1"], { placement: "rightEditor" });
		c.clearHookWidgets();
		expect(rightInfo.at(-1)).toBeUndefined();
	});
});
