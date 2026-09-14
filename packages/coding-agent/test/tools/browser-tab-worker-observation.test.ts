import { describe, expect, it } from "bun:test";
import type { ElementHandle, Page } from "puppeteer-core";
import { captureAriaSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/aria/aria-snapshot";
import { ensureChromiumExecutable, loadPuppeteer } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	collectBiDiObservationEntries,
	parseAriaSnapshotLines,
	type WorkerCore,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function fakeActionableHandle(): ElementHandle {
	const element = {
		disabled: false,
		required: false,
		readOnly: false,
		multiple: false,
		tagName: "BUTTON",
		ownerDocument: { getElementById: () => null },
		getAttribute: () => null,
		matches: () => false,
	};
	return {
		isIntersectingViewport: async () => true,
		evaluate: async (fn: (value: typeof element) => unknown) => fn(element),
		dispose: async () => {},
	} as unknown as ElementHandle;
}

function observationHarness(viewport: { width: number; height: number }) {
	const handle = fakeActionableHandle();
	const cached = new Map<number, ElementHandle>();
	let nextId = 0;
	const core = {
		nextElementId: () => ++nextId,
		cacheElement: (id: number, value: ElementHandle) => cached.set(id, value),
	} as unknown as WorkerCore;
	const page = {
		evaluate: async () => viewport,
		evaluateHandle: async () => ({ asElement: () => handle }),
	} as unknown as Page;
	return { core, page, cached };
}

describe("Firefox BiDi viewport observation", () => {
	it("keeps visible reference-less content using serialized viewport-relative boxes", async () => {
		const { core, page } = observationHarness({ width: 800, height: 600 });
		const snapshot = [
			'- heading "Visible heading" [level=2] [box=10,20,200,40]',
			'- paragraph "Partially visible" [box=790,100,40,20]',
			'- paragraph "Parent" [box=20,200,300,80]',
			'  - text: "Visible child text"',
			'- paragraph "Geometry-less sibling"',
			'  - text: "Must not borrow the previous sibling box"',
		].join("\n");

		const entries = await collectBiDiObservationEntries(core, page, snapshot, {
			includeAll: true,
			viewportOnly: true,
			refOwner: "test-owner",
		});

		expect(
			entries.map((entry: { role: string; name?: string; actionable?: boolean }) => [
				entry.role,
				entry.name,
				entry.actionable,
			]),
		).toEqual([
			["heading", "Visible heading", false],
			["paragraph", "Partially visible", false],
			["paragraph", "Parent", false],
			["text", "Visible child text", false],
		]);
	});

	it("drops offscreen, zero-area, and geometry-less reference-less content", async () => {
		const { core, page } = observationHarness({ width: 800, height: 600 });
		const snapshot = [
			'- heading "Below viewport" [box=10,600,200,40]',
			'- paragraph "Left of viewport" [box=-100,10,100,20]',
			'- paragraph "Zero width" [box=10,10,0,20]',
			'- paragraph "Zero height" [box=10,10,20,0]',
			'- text: "No geometric ancestor"',
		].join("\n");

		const entries = await collectBiDiObservationEntries(core, page, snapshot, {
			includeAll: true,
			viewportOnly: true,
			refOwner: "test-owner",
		});

		expect(entries).toEqual([]);
	});

	it("retains a visible ref-based actionable node with its real ref resolution path", async () => {
		const { core, page, cached } = observationHarness({ width: 800, height: 600 });
		const entries = await collectBiDiObservationEntries(core, page, '- button "Submit" [ref=e7] [box=20,20,100,30]', {
			includeAll: true,
			viewportOnly: true,
			refOwner: "test-owner",
		});

		expect(entries).toEqual([{ id: 1, role: "button", name: "Submit", states: [] }]);
		expect(cached.has(1)).toBe(true);
	});

	it("parses serialized getBoundingClientRect coordinates and inherits ancestor boxes for text", () => {
		expect(parseAriaSnapshotLines('- paragraph "Parent" [box=-10,20,31,41]\n  - text: Child')).toEqual([
			{ role: "paragraph", name: "Parent", states: [], box: { x: -10, y: 20, width: 31, height: 41 } },
			{ role: "text", name: "Child", states: [], box: { x: -10, y: 20, width: 31, height: 41 } },
		]);
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"filters real serialized page content without dropping visible headings",
		async () => {
			const puppeteer = await loadPuppeteer();
			const browser = await puppeteer.launch({
				executablePath: await ensureChromiumExecutable(),
				headless: true,
				args: ["--no-sandbox"],
			});
			try {
				const page = await browser.newPage();
				await page.setViewport({ width: 800, height: 600 });
				await page.setContent(
					"<h2>Visible heading</h2><p>Visible paragraph</p><button>Submit</button>" +
						'<p style="position:absolute;top:1500px">Offscreen paragraph</p>',
				);
				const snapshot = await captureAriaSnapshot(page, null, { boxes: true }, "viewport-test");
				const { core } = observationHarness({ width: 800, height: 600 });
				const entries = await collectBiDiObservationEntries(core, page, snapshot, {
					includeAll: true,
					viewportOnly: true,
					refOwner: "viewport-test",
				});
				expect(entries.some(entry => entry.role === "heading" && entry.name === "Visible heading")).toBe(true);
				expect(
					entries.some(entry => entry.name === "Visible paragraph"),
					snapshot,
				).toBe(true);
				expect(entries.some(entry => entry.role === "button" && entry.name === "Submit")).toBe(true);
				expect(entries.some(entry => entry.name === "Offscreen paragraph")).toBe(false);
			} finally {
				await browser.close();
			}
		},
		30_000,
	);
});
