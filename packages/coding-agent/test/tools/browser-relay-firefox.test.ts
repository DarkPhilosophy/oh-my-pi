import { describe, expect, it } from "bun:test";
import type { FirefoxRelayBrowserHandle } from "../../src/tools/browser/registry";
import { DEFAULT_FIREFOX_BIDI_URL, validateFirefoxWebSocketUrl } from "../../src/tools/browser/relay/firefox";
import { buildInitPayload } from "../../src/tools/browser/tab-supervisor";
import { parseAriaSnapshotLines } from "../../src/tools/browser/tab-worker";

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
					'    - /url: "/ignored"',
				].join("\n"),
			),
		).toEqual([
			{ ref: "e7", role: "button", name: 'Save "draft"', states: ["disabled"] },
			{ ref: "e8", role: "textbox", name: "Title", states: [] },
		]);
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
});
