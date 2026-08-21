import { describe, expect, it } from "bun:test";
import MODELS_JSON from "@oh-my-pi/pi-catalog/models.json" with { type: "json" };
import { CATALOG_PROVIDERS, DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { applyXAIOAuthCuration, buildXaiOAuthStaticSeed } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// Pins the invariant: bundled `models.json` carries every entry the runtime
// curated catalog (XAI_OAUTH_CURATED_MODELS, surfaced via
// buildXaiOAuthStaticSeed) emits. Without this, editing the curated list
// without regenerating `models.json` silently regresses the boot-time
// default-model resolver — the registry sees the runtime seed only after
// `refresh()`, but interactive boot resolves the persisted default
// synchronously from `#loadModels()`, which reads only `models.json`.
//
// Failure here means: run `bun run gen:models` and commit the diff.
describe("xai-oauth bundled catalog (regression)", () => {
	const bundled =
		(MODELS_JSON as unknown as Record<string, Record<string, ModelSpec<"openai-responses">>>)["xai-oauth"] ?? {};
	const seed = buildXaiOAuthStaticSeed();

	it("defaults SuperGrok selection to grok-4.6", () => {
		const entry = CATALOG_PROVIDERS.find(provider => provider.id === "xai-oauth");
		expect(entry?.defaultModel).toBe("grok-4.6");
		expect(DEFAULT_MODEL_PER_PROVIDER["xai-oauth"]).toBe("grok-4.6");
		expect(bundled["grok-4.6"], "xai-oauth/grok-4.6 must be bundled for the default").toBeDefined();
	});
	it("bundles every curated id", () => {
		const seededIds = seed.map(model => model.id).sort();
		const bundledIds = Object.keys(bundled).sort();
		expect(bundledIds).toEqual(seededIds);
	});

	for (const seededModel of seed) {
		it(`matches contract for ${seededModel.id}`, () => {
			const bundledEntry = bundled[seededModel.id];
			expect(bundledEntry, `xai-oauth/${seededModel.id} missing from models.json`).toBeDefined();
			expect(bundledEntry.id).toBe(seededModel.id);
			expect(bundledEntry.name).toBe(seededModel.name);
			expect(bundledEntry.provider).toBe("xai-oauth");
			expect(bundledEntry.api).toBe("openai-responses");
			expect(bundledEntry.contextWindow).toBe(seededModel.contextWindow);
			expect(bundledEntry.reasoning).toBe(seededModel.reasoning);
			// Input modality must survive both the curated seed and the bundle.
			// Without this the static fallback used on offline boot strips
			// vision capability silently (Codex PR #1127 review).
			expect(bundledEntry.input).toEqual(seededModel.input);
			expect(bundledEntry.compat?.supportsReasoningEffort).toBe(seededModel.compat?.supportsReasoningEffort);
		});
	}

	// Absolute contract for the user-specified SuperGrok addition. The parity
	// loop above can't catch a value typo (e.g. 2_000_000) or a flipped
	// reasoning flag — both sides regenerate from the same seed together — so
	// pin the literal attributes here.
	it("exposes grok-composer-2.5-fast as a non-reasoning 200K text model", () => {
		const composer = seed.find(model => model.id === "grok-composer-2.5-fast");
		expect(composer, "grok-composer-2.5-fast must be in the SuperGrok curated seed").toBeDefined();
		expect(composer!.reasoning).toBe(false);
		expect(composer!.contextWindow).toBe(200_000);
		expect(composer!.input).toEqual(["text"]);
		// The bundled models.json entry is byte-identical to the generator's
		// deterministic xai-oauth output: gen:models pushes
		// buildXaiOAuthStaticSeed() (offline — xai-oauth has no upstream catalog
		// source) and applyGeneratedModelPolicies(), so a regen reproduces these
		// exact bytes; only unrelated other-provider network churn was excluded
		// to keep the diff scoped. Pin its zero-cost invariant (overlay-stable
		// for the SuperGrok subscription), which the parity loop above never
		// compares. (maxTokens is pinned by the maxTokens-equals-contextWindow
		// test below.)
		expect(bundled["grok-composer-2.5-fast"]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("exposes grok-4.5 as a reasoning 500K text+image model", () => {
		const grok45 = seed.find(model => model.id === "grok-4.5");
		expect(grok45, "grok-4.5 must be in the SuperGrok curated seed").toBeDefined();
		expect(grok45!.reasoning).toBe(true);
		expect(grok45!.contextWindow).toBe(500_000);
		expect(grok45!.input).toEqual(["text", "image"]);
		expect(bundled["grok-4.5"]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
	// The OAuth surface's /v1/models reports no per-request output limit, so the
	// curated catalog owns maxTokens — set to mirror each model's contextWindow
	// (the openai-responses wire still clamps the actual request to
	// OPENAI_MAX_OUTPUT_TOKENS). Pin maxTokens === contextWindow on both the
	// static-seed and bundled paths so a null placeholder can
	// never silently leak back into the bundle.
	it("sets maxTokens equal to contextWindow for every xai-oauth model", () => {
		for (const model of seed) {
			expect(model.maxTokens, `seed ${model.id} maxTokens`).toBe(model.contextWindow);
			expect(bundled[model.id]?.maxTokens, `bundled ${model.id} maxTokens`).toBe(model.contextWindow);
		}
	});

	// Documented grok-4.5 aliases (docs.x.ai/developers/models/grok-4.5) may
	// appear in /v1/models; dropping them keeps the curated grok-4.5 entry as
	// the sole owner of vision/reasoning/context metadata.
	it("drops grok-4.5-latest and grok-build-latest aliases during curation", () => {
		const dynamic: ModelSpec<"openai-responses">[] = [
			{
				id: "grok-4.5-latest",
				name: "Grok 4.5 Latest",
				api: "openai-responses",
				provider: "xai-oauth",
				baseUrl: "https://api.x.ai/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 128_000,
			},
			{
				id: "grok-build-latest",
				name: "Grok Build Latest",
				api: "openai-responses",
				provider: "xai-oauth",
				baseUrl: "https://api.x.ai/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 128_000,
			},
			{
				id: "grok-4.5",
				name: "Grok 4.5 (raw)",
				api: "openai-responses",
				provider: "xai-oauth",
				baseUrl: "https://api.x.ai/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 128_000,
			},
			{
				id: "grok-4.3",
				name: "Grok 4.3 (raw)",
				api: "openai-responses",
				provider: "xai-oauth",
				baseUrl: "https://api.x.ai/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 128_000,
			},
		];

		const curated = applyXAIOAuthCuration(dynamic);
		const ids = curated.map(model => model.id);
		expect(ids).not.toContain("grok-4.5-latest");
		expect(ids).not.toContain("grok-build-latest");
		expect(ids).toContain("grok-4.5");
		expect(ids).toContain("grok-4.3");

		const grok45 = curated.find(model => model.id === "grok-4.5");
		expect(grok45).toBeDefined();
		if (!grok45) {
			return;
		}
		expect(grok45.reasoning).toBe(true);
		expect(grok45.input).toContain("image");
		expect(grok45.contextWindow).toBe(500_000);
	});

	// Inject path must not leak the structural template's compat into the
	// curated entry. When /v1/models returns only a non-effort model
	// (grok-build with omitReasoningEffort:true) and omits grok-4.5, the
	// inject pass clones that entry as a template — without resetting
	// compat, grok-4.5 inherits omitReasoningEffort:true and silently
	// drops the user's low/medium effort dial.
	it("resets template compat when injecting missing curated models", () => {
		const dynamic: ModelSpec<"openai-responses">[] = [
			{
				id: "grok-build",
				name: "Grok Build (raw)",
				api: "openai-responses",
				provider: "xai-oauth",
				baseUrl: "https://api.x.ai/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 128_000,
				compat: { omitReasoningEffort: true },
			},
		];

		const curated = applyXAIOAuthCuration(dynamic);

		const grok45 = curated.find(model => model.id === "grok-4.5");
		expect(grok45).toBeDefined();
		if (!grok45) {
			return;
		}
		// Injected effort-capable model must recompute omitReasoningEffort
		// from its own id, not inherit the template's true.
		expect(grok45.compat?.omitReasoningEffort).toBe(false);
		expect(grok45.reasoning).toBe(true);
		expect(grok45.contextWindow).toBe(500_000);
		expect(grok45.input).toContain("image");

		// Overlay path still preserves the non-effort contract for the
		// template model itself (curated supportsReasoningEffort:false).
		const grokBuild = curated.find(model => model.id === "grok-build");
		expect(grokBuild).toBeDefined();
		if (!grokBuild) {
			return;
		}
		expect(grokBuild.compat?.omitReasoningEffort).toBe(true);
	});
});
