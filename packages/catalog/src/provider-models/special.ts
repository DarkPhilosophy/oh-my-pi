import { once } from "@oh-my-pi/pi-utils";
import { fetchCodexModels } from "../discovery/codex";
import type { DevinModelDiscoveryOptions } from "../discovery/devin";
import { buildGitLabDuoWorkflowFallbackModel, fetchGitLabDuoWorkflowModels } from "../discovery/gitlab-duo-workflow";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl } from "../types";

// ---------------------------------------------------------------------------
// OpenAI Codex
// ---------------------------------------------------------------------------

export interface OpenAICodexModelManagerConfig {
	accessToken?: string;
	accountId?: string;
	clientVersion?: string;
	fetch?: FetchImpl;
}

export function openaiCodexModelManagerOptions(
	config: OpenAICodexModelManagerConfig = {},
): ModelManagerOptions<"openai-codex-responses"> {
	const { accessToken, accountId, clientVersion, fetch } = config;
	return {
		providerId: "openai-codex",
		dynamicModelsAuthoritative: true,
		...(accessToken
			? {
					fetchDynamicModels: async () => {
						const result = await fetchCodexModels({ accessToken, accountId, clientVersion, fetchFn: fetch });
						return result?.models ?? null;
					},
				}
			: undefined),
	};
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export interface CursorModelManagerConfig {
	apiKey?: string;
	getApiKey?: () => Promise<string | undefined>;
	baseUrl?: string;
	clientVersion?: string;
}

const CURSOR_CACHE_PROVIDER_ID = "cursor:max-mode-v2";

export function cursorModelManagerOptions(config: CursorModelManagerConfig = {}): ModelManagerOptions<"cursor-agent"> {
	const { apiKey: configuredApiKey, getApiKey, baseUrl, clientVersion } = config;
	const hasApiKey = Boolean(configuredApiKey || getApiKey);
	return {
		providerId: "cursor",
		cacheProviderId: CURSOR_CACHE_PROVIDER_ID,
		...(hasApiKey
			? {
					fetchDynamicModels: async () => {
						const apiKey = (getApiKey ? await getApiKey() : undefined) ?? configuredApiKey;
						if (!apiKey) return null;
						const { fetchCursorUsableModels } = await cursorDiscovery();
						return fetchCursorUsableModels({ apiKey, baseUrl, clientVersion });
					},
				}
			: undefined),
	};
}

const cursorDiscovery = once(() => import("../discovery/cursor"));

// ---------------------------------------------------------------------------
// GitLab Duo Workflow
// ---------------------------------------------------------------------------

export interface GitLabDuoWorkflowModelManagerConfig {
	apiKey?: string;
	getApiKey?: () => Promise<string | undefined>;
	cacheIdentity?: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	namespaceId?: string;
	projectId?: string;
	cwd?: string;
}

export function gitLabDuoWorkflowModelManagerOptions(
	config: GitLabDuoWorkflowModelManagerConfig = {},
): ModelManagerOptions<"gitlab-duo-agent"> {
	const { apiKey: configuredApiKey, getApiKey, cacheIdentity } = config;
	const hasApiKey = Boolean(configuredApiKey || getApiKey);
	// Prefer the OAuth cache identity over a configured token: fetchDynamicModels
	// resolves the bearer as `getApiKey() ?? configuredApiKey` (OAuth-first), so
	// the cache key must be OAuth-first too — otherwise a mixed-auth setup (expired
	// OAuth + env/config token) fetches as the OAuth account but caches under the
	// token, serving another account's namespace on a later token-only refresh.
	const cacheKeyIdentity = cacheIdentity ?? configuredApiKey;
	return {
		providerId: "gitlab-duo-agent",
		// GitLab Duo discovery is credential- and namespace-specific
		// (`aiChatAvailableModels(rootNamespaceId:)` also surfaces namespace-pinned
		// models), so the default provider-id cache namespace would let a second
		// account/namespace load the first one's authoritative model list at startup
		// and skip refetching. Partition the cache by a non-reversible fingerprint of
		// the exact inputs `fetchGitLabDuoWorkflowModels` resolves the namespace from
		// (credential/cache identity + base URL + namespace/project config + the same
		// env vars + the effective workspace cwd whose git remote drives
		// auto-discovery). Built-in lazy-OAuth discovery passes the OAuth account's
		// cacheIdentity, which takes precedence over a configured token so the cache
		// key matches the OAuth bearer fetchDynamicModels prefers. Falls back to the
		// bare provider id when no credential identity is present.
		...(cacheKeyIdentity
			? { cacheProviderId: gitLabDuoWorkflowModelCacheProviderId(cacheKeyIdentity, config) }
			: undefined),
		dynamicModelsAuthoritative: true,
		staticModels: [
			buildGitLabDuoWorkflowFallbackModel("claude_sonnet_4_6_vertex", "Claude Sonnet 4.6 - Vertex", config.baseUrl),
		],
		...(hasApiKey
			? {
					fetchDynamicModels: async () => {
						const apiKey = (getApiKey ? await getApiKey() : undefined) ?? configuredApiKey;
						if (!apiKey) return null;
						return fetchGitLabDuoWorkflowModels({
							apiKey,
							baseUrl: config.baseUrl,
							fetch: config.fetch,
							namespaceId: config.namespaceId,
							projectId: config.projectId,
							cwd: config.cwd,
						});
					},
				}
			: undefined),
	};
}

function gitLabDuoWorkflowModelCacheProviderId(identity: string, config: GitLabDuoWorkflowModelManagerConfig): string {
	// Mirror the exact inputs `discoverGitLabDuoWorkflowNamespace` keys off: explicit
	// namespace/project config OR the same env vars, then the git remote at the
	// effective cwd. Built-in discovery leaves the config fields empty, so the env +
	// resolved cwd terms are what actually distinguish two workspaces sharing an
	// OAuth identity or token.
	const namespaceId = config.namespaceId ?? Bun.env.GITLAB_DUO_NAMESPACE_ID ?? "";
	const projectId = config.projectId ?? Bun.env.GITLAB_DUO_PROJECT_ID ?? Bun.env.GITLAB_DUO_PROJECT_PATH ?? "";
	const cwd = config.cwd ?? process.cwd();
	const scope = [config.baseUrl ?? "", namespaceId, projectId, cwd].join("\u0000");
	return `gitlab-duo-agent:${Bun.hash(`${identity}\u0000${scope}`).toString(36)}`;
}

// Devin (Codeium Cascade)
// ---------------------------------------------------------------------------

export interface DevinModelManagerConfig {
	apiKey?: string;
	getApiKey?: () => Promise<string | undefined>;
	baseUrl?: string;
	fetch?: DevinModelDiscoveryOptions["fetch"];
}

export function devinModelManagerOptions(config: DevinModelManagerConfig = {}): ModelManagerOptions<"devin-agent"> {
	const { apiKey: configuredApiKey, getApiKey, baseUrl, fetch } = config;
	const hasApiKey = Boolean(configuredApiKey || getApiKey);
	return {
		providerId: "devin",
		...(hasApiKey ? { dynamicModelsAuthoritative: true } : undefined),
		...(hasApiKey
			? {
					fetchDynamicModels: async () => {
						const apiKey = (getApiKey ? await getApiKey() : undefined) ?? configuredApiKey;
						if (!apiKey) return null;
						const { fetchDevinModels } = await devinDiscovery();
						return fetchDevinModels({ apiKey, baseUrl, fetch });
					},
				}
			: undefined),
	};
}

const devinDiscovery = once(() => import("../discovery/devin"));
// ---------------------------------------------------------------------------
// Zai
// ---------------------------------------------------------------------------

export interface ZaiModelManagerConfig {}

export function zaiModelManagerOptions(_config: ZaiModelManagerConfig = {}): ModelManagerOptions<"anthropic-messages"> {
	return { providerId: "zai" };
}
