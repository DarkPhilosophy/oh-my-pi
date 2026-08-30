import { describe, expect, it } from "bun:test";
import type { Page } from "puppeteer-core";
import type { FirefoxRelayBrowserHandle } from "../../src/tools/browser/registry";
import { DEFAULT_FIREFOX_BIDI_URL, validateFirefoxWebSocketUrl } from "../../src/tools/browser/relay/firefox";
import {
	buildInitPayload,
	FirefoxSharedTabRegistry,
	forceKillTab,
	getTabsMapForTest,
	releaseTab,
	selectFirefoxWorkerTab,
	type WorkerHandle,
	type WorkerTabSession,
} from "../../src/tools/browser/tab-supervisor";
import {
	findBiDiPageByTargetId,
	isInteractiveAriaSnapshotNode,
	parseAriaSnapshotLines,
} from "../../src/tools/browser/tab-worker";

function createFirefoxHandle(webSocketUrl: string): FirefoxRelayBrowserHandle {
	return {
		key: `firefox-relay:${webSocketUrl}`,
		kind: { kind: "firefox-relay", webSocketUrl },
		webSocketUrl,
		refCount: 0,
	};
}

function createFirefoxTab(name: string, browser: FirefoxRelayBrowserHandle, worker: WorkerHandle): WorkerTabSession {
	return {
		name,
		browser,
		worker,
		backend: "worker",
		activateForScreenshot: false,
		state: "alive",
		kindTag: "firefox-relay",
		pending: new Map(),
		info: { url: "about:blank", viewport: { width: 1280, height: 720 }, targetId: name },
	} as unknown as WorkerTabSession;
}
describe("Firefox WebDriver BiDi relay", () => {
	it("accepts local WebSocket endpoints used by Firefox-family browsers", () => {
		expect(validateFirefoxWebSocketUrl(DEFAULT_FIREFOX_BIDI_URL)).toBe(DEFAULT_FIREFOX_BIDI_URL);
		expect(validateFirefoxWebSocketUrl("ws://localhost:9333/session/")).toBe("ws://localhost:9333/session");
	});

	it("rejects non-WebSocket and non-loopback endpoints", () => {
		expect(() => validateFirefoxWebSocketUrl("http://127.0.0.1:9222/session")).toThrow("must use ws:// or wss://");
		expect(() => validateFirefoxWebSocketUrl("ws://example.com:9222/session")).toThrow("Refusing non-loopback");
	});

	it("converts BiDi-safe ARIA snapshot rows into observation metadata", () => {
		expect(
			parseAriaSnapshotLines(
				[
					'- button "Save \\"draft\\"" [ref=e7] [disabled] [cursor=pointer]',
					'  - textbox "Title" [ref=e8]',
					`  - 'button "Save: draft" [ref=e9]'`,
					'- button "Escape\\x1bkey" [ref=e10]',
					'- button "Open [ref=e999]" [ref=e11] [focused]',
					'    - /url: "/ignored"',
				].join("\n"),
			),
		).toEqual([
			{ ref: "e7", role: "button", name: 'Save "draft"', states: ["disabled"] },
			{ ref: "e8", role: "textbox", name: "Title", states: [] },
			{ ref: "e9", role: "button", name: "Save: draft", states: [] },
			{ ref: "e10", role: "button", name: "Escape\u001bkey", states: [] },
			{ ref: "e11", role: "button", name: "Open [ref=e999]", states: ["focused"] },
		]);
	});

	it("ignores structural ARIA metadata while retaining actionable serializer states", () => {
		expect(isInteractiveAriaSnapshotNode("heading", ["level=2"])).toBe(false);
		expect(isInteractiveAriaSnapshotNode("heading", ["invalid=false"])).toBe(false);
		expect(isInteractiveAriaSnapshotNode("treeitem", ["expanded"])).toBe(true);
		expect(isInteractiveAriaSnapshotNode("generic", ["active"])).toBe(true);
		expect(isInteractiveAriaSnapshotNode("checkbox", [])).toBe(true);
	});

	it("delegates discovery to the sole BiDi worker without opening a registry session", async () => {
		const handle: FirefoxRelayBrowserHandle = {
			key: `firefox-relay:${DEFAULT_FIREFOX_BIDI_URL}`,
			kind: { kind: "firefox-relay", webSocketUrl: DEFAULT_FIREFOX_BIDI_URL },
			webSocketUrl: DEFAULT_FIREFOX_BIDI_URL,
			refCount: 0,
		};

		const payload = await buildInitPayload(handle, { timeoutMs: 1_000, target: "account" });

		expect(payload).toMatchObject({
			mode: "attach",
			targetId: "",
			targetMatcher: "account",
			protocol: "webDriverBiDi",
			activateForScreenshot: true,
		});
	});

	it("keeps worker ownership isolated by Firefox endpoint through close", () => {
		const registry = new FirefoxSharedTabRegistry();
		const endpointA = createFirefoxHandle("ws://127.0.0.1:9222/session");
		const endpointB = createFirefoxHandle("ws://127.0.0.1:9333/session");
		const workerA = {} as WorkerHandle;
		const workerB = {} as WorkerHandle;
		const tabA = createFirefoxTab("firefox-a", endpointA, workerA);
		const tabB = createFirefoxTab("firefox-b", endpointB, workerB);

		registry.set(tabA);
		expect(registry.get(endpointA)).toBe(tabA);

		registry.set(tabB);
		expect(registry.get(endpointA)).toBe(tabA);
		expect(registry.get(endpointB)).toBe(tabB);

		registry.delete(tabA);
		expect(registry.get(endpointA)).toBeUndefined();
		expect(registry.get(endpointB)).toBe(tabB);
	});

	it("reuses the endpoint worker after one of two named aliases closes", () => {
		const registry = new FirefoxSharedTabRegistry();
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		const worker = {} as WorkerHandle;
		const original = createFirefoxTab("firefox-first", endpoint, worker);
		const alias = createFirefoxTab("firefox-second", endpoint, worker);

		registry.set(original);
		// Closing an alias removes only that name from the supervisor's tabs map.
		// The endpoint registry continues to own the original live worker.
		alias.state = "dead";

		const third = registry.get(endpoint);
		expect(third).toBe(original);
		expect(third?.worker).toBe(worker);
	});

	it("rejects a closed Firefox browsing context instead of falling back to another tab", async () => {
		const page = { mainFrame: () => ({ _id: "live-context" }) } as unknown as Page;
		await expect(findBiDiPageByTargetId([page], "closed-context")).rejects.toThrow(
			"Target closed-context is no longer available",
		);
	});

	it("serializes concurrent selections on the shared Firefox worker", async () => {
		const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
		const sends: string[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const worker: WorkerHandle = {
			mode: "inline",
			send: msg => {
				if (msg.type !== "select") return;
				sends.push(msg.targetMatcher ?? "");
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				setTimeout(() => {
					inFlight--;
					for (const listener of listeners) {
						listener({
							type: "selected",
							id: msg.id,
							info: {
								url: `https://${msg.targetMatcher}.example`,
								viewport: { width: 1280, height: 720 },
								targetId: msg.targetMatcher ?? "",
							},
						});
					}
				}, 5);
			},
			onMessage: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onError: () => () => undefined,
			terminate: async () => undefined,
		};

		const [first, second] = await Promise.all([
			selectFirefoxWorkerTab(worker, { targetMatcher: "first", timeoutMs: 1_000 }),
			selectFirefoxWorkerTab(worker, { targetMatcher: "second", timeoutMs: 1_000 }),
		]);

		expect(sends).toEqual(["first", "second"]);
		expect(maxInFlight).toBe(1);
		expect(first.targetId).toBe("first");
		expect(second.targetId).toBe("second");
	});

	it("cancels an in-flight Firefox selection before publishing an alias", async () => {
		const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
		const sent: string[] = [];
		const worker = {
			mode: "inline",
			send: msg => {
				sent.push(msg.type);
				if (msg.type !== "abort-select") return;
				for (const listener of listeners) {
					listener({
						type: "select-failed",
						id: msg.id,
						error: {
							name: "ToolAbortError",
							message: "Selection aborted",
							isAbort: true,
							isToolError: true,
						},
					});
				}
			},
			onMessage: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onError: () => () => undefined,
			terminate: async () => undefined,
		} satisfies WorkerHandle;
		const ac = new AbortController();
		const selection = selectFirefoxWorkerTab(worker, {
			targetMatcher: "cancelled",
			timeoutMs: 1_000,
			signal: ac.signal,
		});
		await Bun.sleep(0);

		ac.abort();

		await expect(selection).rejects.toThrow();
		expect(sent).toEqual(["select", "abort-select"]);
	});

	it("releases the selection lock when cancellation precedes dispatch", async () => {
		const listeners = new Set<Parameters<WorkerHandle["onMessage"]>[0]>();
		const sent: string[] = [];
		const worker = {
			mode: "inline",
			send: msg => {
				sent.push(msg.type);
				if (msg.type !== "select") return;
				for (const listener of listeners) {
					listener({
						type: "selected",
						id: msg.id,
						info: {
							url: "https://second.example",
							viewport: { width: 1280, height: 720 },
							targetId: "second",
						},
					});
				}
			},
			onMessage: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			onError: () => () => undefined,
			terminate: async () => undefined,
		} satisfies WorkerHandle;
		const ac = new AbortController();
		ac.abort();

		await expect(
			selectFirefoxWorkerTab(worker, { targetMatcher: "cancelled", timeoutMs: 1_000, signal: ac.signal }),
		).rejects.toThrow();
		const second = await selectFirefoxWorkerTab(worker, { targetMatcher: "second", timeoutMs: 1_000 });

		expect(second.targetId).toBe("second");
		expect(sent).toEqual(["select"]);
	});

	it("force-kills one Firefox alias without terminating its shared worker", async () => {
		let terminations = 0;
		const sent: string[] = [];
		const worker = {
			mode: "inline",
			send: msg => sent.push(msg.type),
			onMessage: () => () => undefined,
			onError: () => () => undefined,
			terminate: async () => {
				terminations++;
			},
		} satisfies WorkerHandle;
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		endpoint.refCount = 2;
		const first = createFirefoxTab("firefox-drop-first", endpoint, worker);
		const second = createFirefoxTab("firefox-keep-second", endpoint, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(first.name, first);
		tabs.set(second.name, second);

		await forceKillTab(first.name, "first alias failed");

		expect(terminations).toBe(0);
		expect(sent).toContain("release-runtime");
		expect(first.state).toBe("dead");
		expect(second.state).toBe("alive");
		expect(tabs.has(first.name)).toBe(false);
		expect(tabs.get(second.name)?.worker).toBe(worker);
		expect(endpoint.refCount).toBe(1);
		await forceKillTab(second.name, "test cleanup", { sharedFirefoxWorker: true });
		expect(tabs.has(second.name)).toBe(false);
		expect(endpoint.refCount).toBe(0);
	});

	it("releases an idle Firefox alias while its sibling owns the shared run", async () => {
		const worker = {
			mode: "inline",
			send: () => undefined,
			onMessage: () => () => undefined,
			onError: () => () => undefined,
			terminate: async () => undefined,
		} satisfies WorkerHandle;
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		endpoint.refCount = 2;
		const idle = createFirefoxTab("firefox-idle-owner", endpoint, worker);
		const busy = createFirefoxTab("firefox-busy-sibling", endpoint, worker);
		const sharedPending = new Map([
			[
				"busy-run",
				{
					tabName: busy.name,
					resolve: () => undefined,
					reject: () => undefined,
					session: {},
					toolCalls: new Map(),
				},
			],
		]) as unknown as WorkerTabSession["pending"];
		idle.pending = sharedPending;
		busy.pending = sharedPending;
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(idle.name, idle);
		tabs.set(busy.name, busy);

		await releaseTab(idle.name);

		expect(tabs.has(idle.name)).toBe(false);
		expect(tabs.get(busy.name)?.state).toBe("alive");
		sharedPending.clear();
		await forceKillTab(busy.name, "test cleanup", { sharedFirefoxWorker: true });
	});

	it("invalidates every alias when the shared Firefox worker is killed", async () => {
		let terminations = 0;
		const worker = {
			mode: "inline",
			send: () => undefined,
			onMessage: () => () => undefined,
			onError: () => () => undefined,
			terminate: async () => {
				terminations++;
			},
		} satisfies WorkerHandle;
		const endpoint = createFirefoxHandle(DEFAULT_FIREFOX_BIDI_URL);
		endpoint.refCount = 2;
		const first = createFirefoxTab("firefox-kill-first", endpoint, worker);
		const second = createFirefoxTab("firefox-kill-second", endpoint, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(first.name, first);
		tabs.set(second.name, second);

		await forceKillTab(first.name, "shared Firefox worker failed", { sharedFirefoxWorker: true });

		expect(terminations).toBe(1);
		expect(first.state).toBe("dead");
		expect(second.state).toBe("dead");
		expect(tabs.has(first.name)).toBe(false);
		expect(tabs.has(second.name)).toBe(false);
		expect(endpoint.refCount).toBe(0);
	});
});
