import { afterEach, describe, expect, it } from "bun:test";
import type { FirefoxRelayBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type {
	RunErrorPayload,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	acquireTab,
	getFirefoxSharedTabsForTest,
	getTabsMapForTest,
	type WorkerHandle,
	type WorkerTabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
class FakeSelectionWorker implements WorkerHandle {
	readonly mode = "inline" as const;
	readonly sent: WorkerInbound[] = [];
	terminateCalls = 0;
	#handlers = new Set<(message: WorkerOutbound) => void>();
	send(message: WorkerInbound): void {
		this.sent.push(message);
	}
	onMessage(handler: (message: WorkerOutbound) => void): () => void {
		this.#handlers.add(handler);
		return () => this.#handlers.delete(handler);
	}
	onError(): () => void {
		return () => undefined;
	}
	async terminate(): Promise<void> {
		this.terminateCalls++;
	}
	failSelection(error: RunErrorPayload): void {
		const request = this.sent.at(-1);
		if (!request || request.type !== "select") throw new Error("Expected pending selection");
		for (const handler of this.#handlers) handler({ type: "select-failed", id: request.id, error });
	}
}
function makeBrowser(): FirefoxRelayBrowserHandle {
	return {
		key: "firefox-relay:ws://127.0.0.1:9222/session",
		kind: { kind: "firefox-relay", webSocketUrl: "ws://127.0.0.1:9222/session" },
		webSocketUrl: "ws://127.0.0.1:9222/session",
		refCount: 2,
	};
}
function makeTab(name: string, browser: FirefoxRelayBrowserHandle, worker: WorkerHandle): WorkerTabSession {
	return {
		name,
		browser,
		worker,
		backend: "worker",
		targetId: `${name}-target`,
		state: "alive",
		info: { url: "about:blank", title: name, viewport: { width: 1280, height: 720 }, targetId: `${name}-target` },
		pending: new Map(),
		kindTag: "firefox-relay",
		activateForScreenshot: false,
	} as WorkerTabSession;
}
describe("Firefox shared worker selection recovery", () => {
	afterEach(() => {
		(getTabsMapForTest() as Map<string, WorkerTabSession>).clear();
	});
	it("invalidates every alias when acquireTab selection fails recoverably", async () => {
		const worker = new FakeSelectionWorker();
		const browser = makeBrowser();
		const primary = makeTab("primary", browser, worker);
		const alias = makeTab("alias", browser, worker);
		const tabs = getTabsMapForTest() as Map<string, WorkerTabSession>;
		tabs.set(primary.name, primary);
		tabs.set(alias.name, alias);
		getFirefoxSharedTabsForTest().set(primary);
		const opening = acquireTab("new-alias", browser, { target: "requested", timeoutMs: 1_000 });
		await Bun.sleep(0);
		worker.failSelection({
			name: "TimeoutError",
			message: "Selection navigation timed out",
			isToolError: true,
			isAbort: false,
			recoverTab: true,
		});
		await expect(opening).rejects.toThrow("Selection navigation timed out");
		expect(worker.terminateCalls).toBe(1);
		expect(primary.state).toBe("dead");
		expect(alias.state).toBe("dead");
		expect(tabs.has("primary")).toBe(false);
		expect(tabs.has("alias")).toBe(false);
		expect(browser.refCount).toBe(0);
	});
});
