import { describe, expect, it, vi } from "bun:test";
import { compositeRightPanelsInRange, Container, type PanelLayoutResult, type RightPanelBlock } from "@oh-my-pi/pi-tui";
import type { ExtensionUIContext, WidgetLayoutEvent } from "../../extensibility/extensions";
import { CustomEditor } from "../components/custom-editor";
import { getEditorTheme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";
import { ExtensionUiController } from "./extension-ui-controller";

function makeHarness() {
	const editor = new CustomEditor(getEditorTheme());
	const requestRender = vi.fn();
	const addAutocompleteProvider = vi.fn();
	let uiContext: ExtensionUIContext | undefined;
	const ctx = {
		editor,
		ui: {
			requestRender,
		},
		session: {
			extensionRunner: undefined,
			setUsageFallbackConfirmer: vi.fn(),
		},
		setToolUIContext(context: ExtensionUIContext, hasUI: boolean): void {
			expect(hasUI).toBe(true);
			uiContext = context;
		},
		hookWidgetContainerAbove: new Container(),
		hookWidgetContainerBelow: new Container(),
		setRightInfo: vi.fn(),
		addAutocompleteProvider,
		syncComposerShape: vi.fn(),
	} as unknown as InteractiveModeContext;

	return {
		editor,
		requestRender,
		addAutocompleteProvider,
		async init(): Promise<ExtensionUIContext> {
			await new ExtensionUiController(ctx).initHooksAndCustomTools();
			requestRender.mockClear();
			expect(uiContext).toBeDefined();
			return uiContext!;
		},
	};
}

describe("ExtensionUiController editor UI", () => {
	it("requests a render after extension pasteToEditor mutates the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.pasteToEditor("hello");
		ui.pasteToEditor(" world");

		expect(harness.editor.getText()).toBe("hello world");
		expect(harness.requestRender).toHaveBeenCalledTimes(2);
	});

	it("requests a render after extension setEditorText replaces the prompt", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		ui.setEditorText("hello");

		expect(harness.editor.getText()).toBe("hello");
		expect(harness.requestRender).toHaveBeenCalledTimes(1);
	});

	it("bridges addAutocompleteProvider factories to the interactive mode context (#4919)", async () => {
		const harness = makeHarness();
		const ui = await harness.init();

		expect(typeof ui.addAutocompleteProvider).toBe("function");

		const factory = (current: unknown) => current as never;
		ui.addAutocompleteProvider(factory);

		expect(harness.addAutocompleteProvider).toHaveBeenCalledTimes(1);
		expect(harness.addAutocompleteProvider).toHaveBeenCalledWith(factory);
	});
});

describe("ExtensionUiController widget visibility", () => {
	it("delivers actual compositor visibility transitions to the current extension runner", async () => {
		const events: WidgetLayoutEvent[] = [];
		const replacementEvents: WidgetLayoutEvent[] = [];
		const runner = (received: WidgetLayoutEvent[]) => ({
			hasHandlers: (type: string) => type === "widget_layout",
			emit: async (event: WidgetLayoutEvent) => {
				received.push(event);
			},
		});
		let provider: ((width: number) => RightPanelBlock[]) | undefined;
		let onLayout: ((result: PanelLayoutResult) => void) | undefined;
		const session = { extensionRunner: runner(events) };
		const ctx = {
			session,
			ui: { requestRender() {} },
			hookWidgetContainerAbove: new Container(),
			hookWidgetContainerBelow: new Container(),
			setRightInfo(next: typeof provider, callback: typeof onLayout) {
				provider = next;
				onLayout = callback;
			},
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new ExtensionUiController(ctx);
		const mount = () =>
			controller.setHookWidget("visibility-test", [{ id: "ad", lines: ["Sponsor", "Copy", "Footer"] }], {
				placement: "rightEditor",
			});
		const paint = (width: number) => {
			if (provider === undefined || onLayout === undefined) throw new Error("Right panel not mounted");
			return compositeRightPanelsInRange(
				Array.from({ length: 8 }, () => ""),
				provider(width),
				width,
				0,
				8,
				undefined,
				undefined,
				onLayout,
			);
		};

		mount();
		expect(paint(80).some(line => line.includes("Sponsor"))).toBe(true);
		expect(events).toHaveLength(0); // Event delivery must not re-enter synchronous painting.
		await Promise.resolve();
		expect(events).toEqual([
			{
				type: "widget_layout",
				key: "visibility-test",
				visible: true,
				availableWidth: 49,
				visibleRows: 3,
				hiddenBlocks: undefined,
			},
		]);
		paint(80);
		await Promise.resolve();
		expect(events).toHaveLength(1);

		expect(paint(30).some(line => line.includes("Sponsor"))).toBe(false);
		await Promise.resolve();
		expect(events.at(-1)).toMatchObject({
			visible: false,
			visibleRows: 0,
			hiddenBlocks: ["ad"],
		});
		paint(80);
		await Promise.resolve();
		expect(events.map(event => event.visible)).toEqual([true, false, true]);

		// Reload replaces the runner; the controller must not retain the old recipient.
		controller.clearHookWidgets();
		session.extensionRunner = runner(replacementEvents);
		mount();
		paint(80);
		await Promise.resolve();
		expect(replacementEvents.map(event => event.visible)).toEqual([true]);
		expect(events).toHaveLength(3);

		// A queued layout from a widget removed before delivery must not revive it.
		paint(30);
		controller.clearHookWidgets();
		await Promise.resolve();
		expect(replacementEvents).toHaveLength(1);
		expect(ctx.showError).not.toHaveBeenCalled();
	});
});
