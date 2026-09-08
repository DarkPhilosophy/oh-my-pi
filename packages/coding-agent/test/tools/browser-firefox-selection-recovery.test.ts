import { afterEach, describe, expect, it } from "bun:test";
import type { FirefoxRelayBrowserHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import type {
	RunErrorPayload,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	getTabsMapForTest,
	handleFirefoxSelectionErrorForTest,
	selectFirefoxWorkerTabForTest,
	type WorkerTabSession,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

class FakeSelectionWorker {
	readonly mode = "inline" as const;
	readonly sent: WorkerInbound[] = [];
	terminateCalls = 0;
	readonly selectSent = Promise.withResolvers<void>();
	#messageHandlers = new Set<(message: WorkerOutbound) => void>();

	send(message: WorkerInbound): void {
		this.sent.push(message);
		if (message.type === "select") this.selectSent.resolve();
	}

	onMessage(handler: (message: WorkerOutbound) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(): () => void {
		return () => undefined;
	}

	async terminate(): Promise<void> {
		this.terminateCalls++;
	}

	failSelection(error: RunErrorPayload): void {
		const request = this.sent.at(-1);
		if (!request || request.type !== "select") throw new Error("Expected a pending select request");
		for (const handler of this.#messageHandlers) {
			handler({ type: "select-failed", id: request.id, error });
		}
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

function makeTab(name: string, browser: FirefoxRelayBrowserHandle, worker: FakeSelectionWorker): WorkerTabSession {
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
	};
}

async function selectionFailure(worker: FakeSelectionWorker, error: RunErrorPayload): Promise<unknown> {
	const pending = selectFirefoxWorkerTabForTest(worker, {
		name: "selection-test",
		targetId: "requested-target",
		targetMatcher: "requested-alias",
		url: "https://example.test/hangs",
		timeoutMs: 1_000,
	});
	await worker.selectSent.promise;
	worker.failSelection(error);
	return await pending.catch((reason: unknown) => reason);
}

describe("Firefox shared worker selection recovery", () => {
	afterEach(() => {
		(getTabsMapForTest() as Map<string, WorkerTabSession>).clear();
	});

	it("invalidates every alias after a recoverable selection failure without losing target IDs", async () => {
		const worker = new FakeSelectionWorker();
		const browser = makeBrowser();
		const primary = makeTab("primary", browser, worker);
		const alias = makeTab("alias", browser, worker);
		(getTabsMapForTest() as Map<string, WorkerTabSession>).set(primary.name, primary);
		(getTabsMapForTest() as Map<string, WorkerTabSession>).set(alias.name, alias);

		const error = await selectionFailure(worker, {
			name: "TimeoutError",
			message: "Selection navigation timed out; pending navigation stopped",
			isToolError: true,
			isAbort: false,
			recoverTab: true,
		});
		await handleFirefoxSelectionErrorForTest(primary, error);

		expect(primary.state).toBe("dead");
		expect(alias.state).toBe("dead");
		expect(primary.targetId).toBe("primary-target");
		expect(alias.targetId).toBe("alias-target");
		expect(worker.terminateCalls).toBe(1);
		expect(getTabsMapForTest().has("primary")).toBe(false);
		expect(getTabsMapForTest().has("alias")).toBe(false);
		expect(worker.sent[0]).toMatchObject({
			type: "select",
			targetId: "requested-target",
			targetMatcher: "requested-alias",
		});
	});

	it("keeps the shared worker reusable after an ordinary selection failure", async () => {
		const worker = new FakeSelectionWorker();
		const tab = makeTab("primary", makeBrowser(), worker);
		(getTabsMapForTest() as Map<string, WorkerTabSession>).set(tab.name, tab);

		const error = await selectionFailure(worker, {
			name: "ToolError",
			message: "No matching Firefox tab",
			isToolError: true,
			isAbort: false,
		});
		await handleFirefoxSelectionErrorForTest(tab, error);

		expect(tab.state).toBe("alive");
		expect(worker.terminateCalls).toBe(0);
	});
});
