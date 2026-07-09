import { describe, expect, test, vi } from "bun:test";
import { xaiModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("xAI provider discovery", () => {
	// Documented grok-4.5 aliases (docs.x.ai/developers/models/grok-4.5) may
	// surface from /v1/models; drop them so the bundled xai/grok-4.5 entry owns
	// reasoning/vision/limit metadata instead of an alias with discovery defaults.
	test("drops grok-4.5-latest and grok-build-latest aliases from dynamic discovery", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input, init) => {
			const url = String(input);
			expect(url).toBe("https://api.x.ai/v1/models");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xai-test-key");
			return new Response(
				JSON.stringify({
					object: "list",
					data: [
						{ id: "grok-4.5", object: "model" },
						{ id: "grok-4.5-latest", object: "model" },
						{ id: "grok-build-latest", object: "model" },
						{ id: "grok-4-fast", object: "model" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		});

		const options = xaiModelManagerOptions({ apiKey: "xai-test-key", fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();
		const ids = models?.map(model => model.id) ?? [];

		expect(ids).toContain("grok-4.5");
		expect(ids).toContain("grok-4-fast");
		expect(ids).not.toContain("grok-4.5-latest");
		expect(ids).not.toContain("grok-build-latest");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
