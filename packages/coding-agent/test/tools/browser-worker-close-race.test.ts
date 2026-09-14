import { afterEach, expect, it, vi } from "bun:test";
import type { Browser } from "puppeteer-core";
import { getPuppeteerDir } from "@oh-my-pi/pi-utils";
import { loadPuppeteerInWorker } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { Transport, WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { spawnInlineWorkerForTest } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";

afterEach(() => vi.restoreAllMocks());

it("does not acknowledge inline close until a late browser connection has disconnected", async () => {
	const puppeteer = await loadPuppeteerInWorker(getPuppeteerDir());
	const connecting = Promise.withResolvers<void>();
	const connection = Promise.withResolvers<Browser>();
	const disconnecting = Promise.withResolvers<void>();
	const disconnected = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	const events: string[] = [];
	const browser = {
		disconnect: async () => {
			events.push("disconnect-start");
			disconnecting.resolve();
			await disconnected.promise;
			events.push("disconnect-end");
		},
	} as unknown as Browser;
	vi.spyOn(puppeteer, "connect").mockImplementation(() => {
		connecting.resolve();
		return connection.promise;
	});
	let receive: ((message: WorkerInbound | WorkerOutbound) => void) | undefined;
	const transport: Transport = {
		send(message) {
			if (message.type === "closed") {
				events.push("closed");
				closed.resolve();
			}
		},
		onMessage(handler) {
			receive = handler;
			return () => {};
		},
		close() {},
	};
	new WorkerCore(transport, false);
	try {
		receive!({
			type: "init",
			payload: {
				mode: "attach",
				protocol: "webDriverBiDi",
				targetId: "",
				browserWSEndpoint: "ws://127.0.0.1:1/session",
				safeDir: getPuppeteerDir(),
				timeoutMs: 1000,
			},
		});
		await connecting.promise;
		receive!({ type: "close" });
		await Bun.sleep(0);
		expect(events).not.toContain("closed");
		connection.resolve(browser);
		await disconnecting.promise;
		expect(events).not.toContain("closed");
		disconnected.resolve();
		await closed.promise;
		expect(events).toEqual(["disconnect-start", "disconnect-end", "closed"]);
	} finally {
		connection.resolve(browser);
		disconnected.resolve();
		receive!({ type: "close" });
		await closed.promise;
	}
});

it("bounds supervisor termination while retaining cleanup of a late connection", async () => {
	const puppeteer = await loadPuppeteerInWorker(getPuppeteerDir());
	const connecting = Promise.withResolvers<void>();
	const connection = Promise.withResolvers<Browser>();
	const disconnected = Promise.withResolvers<void>();
	vi.spyOn(puppeteer, "connect").mockImplementation(() => {
		connecting.resolve();
		return connection.promise;
	});
	const worker = await spawnInlineWorkerForTest();
	const closed = Promise.withResolvers<void>();
	const unsubscribe = worker.onMessage(message => {
		if (message.type === "closed") closed.resolve();
	});
	try {
		worker.send({
			type: "init",
			payload: {
				mode: "attach",
				protocol: "webDriverBiDi",
				targetId: "",
				browserWSEndpoint: "ws://127.0.0.1:1/session",
				safeDir: getPuppeteerDir(),
				timeoutMs: 1000,
			},
		});
		await connecting.promise;
		// The connection remains pending: termination must still finish.
		await worker.terminate();
	} finally {
		connection.resolve({ disconnect: async () => disconnected.resolve() } as unknown as Browser);
		await disconnected.promise;
		await closed.promise;
		unsubscribe();
	}
}, 3000);
