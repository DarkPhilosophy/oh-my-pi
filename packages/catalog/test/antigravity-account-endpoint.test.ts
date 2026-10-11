import { describe, expect, it } from "bun:test";
import { googleAntigravityModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/google";

const DEFAULT_ENDPOINT = "https://default.example/antigravity";
const ENTERPRISE_ENDPOINT = "https://enterprise.example/antigravity";

function recordingFetch(urls: Map<string, string>): typeof fetch {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const token = new Headers(init?.headers).get("authorization") ?? "";
			urls.set(token, input instanceof Request ? input.url : String(input));
			return Response.json({ models: {} });
		},
		{ preconnect() {} },
	);
}

describe("Antigravity discovery endpoint", () => {
	it("queries each account on the endpoint recorded on its own credential, and falls back to the manager endpoint", async () => {
		const urls = new Map<string, string>();
		const options = googleAntigravityModelManagerOptions({
			endpoint: DEFAULT_ENDPOINT,
			fetch: recordingFetch(urls),
			resolveAccounts: async () => [
				{ accessToken: "token-enterprise", accountKey: "a", apiEndpoint: ENTERPRISE_ENDPOINT },
				{ accessToken: "token-plain", accountKey: "b" },
			],
		});

		await options.fetchDynamicModels?.();

		expect(urls.get("Bearer token-enterprise")).toStartWith(ENTERPRISE_ENDPOINT);
		expect(urls.get("Bearer token-plain")).toStartWith(DEFAULT_ENDPOINT);
	});
});
