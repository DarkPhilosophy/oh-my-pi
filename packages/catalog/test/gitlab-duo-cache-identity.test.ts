import { describe, expect, it } from "bun:test";
import { gitLabDuoWorkflowModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models";

const FIXED_CWD = "/tmp/gitlab-duo-cache-identity-test";
const FIXED_BASE_URL = "https://gitlab.example.com";
const FIXED_NAMESPACE_ID = "";
const FIXED_PROJECT_ID = "";

describe("gitLabDuoWorkflowModelManagerOptions cache identity precedence", () => {
	it("same cacheIdentity with different apiKeys yields identical cacheProviderId", () => {
		const a = gitLabDuoWorkflowModelManagerOptions({
			apiKey: "token-A",
			cacheIdentity: "cred:5",
			baseUrl: FIXED_BASE_URL,
			cwd: FIXED_CWD,
			namespaceId: FIXED_NAMESPACE_ID,
			projectId: FIXED_PROJECT_ID,
		});
		const b = gitLabDuoWorkflowModelManagerOptions({
			apiKey: "token-B",
			cacheIdentity: "cred:5",
			baseUrl: FIXED_BASE_URL,
			cwd: FIXED_CWD,
			namespaceId: FIXED_NAMESPACE_ID,
			projectId: FIXED_PROJECT_ID,
		});

		expect(a.cacheProviderId).toBeDefined();
		expect(a.cacheProviderId).toBe(b.cacheProviderId);
	});

	it("different cacheIdentity values yield different cacheProviderId", () => {
		const a = gitLabDuoWorkflowModelManagerOptions({
			apiKey: "token",
			cacheIdentity: "cred:5",
			baseUrl: FIXED_BASE_URL,
			cwd: FIXED_CWD,
			namespaceId: FIXED_NAMESPACE_ID,
			projectId: FIXED_PROJECT_ID,
		});
		const b = gitLabDuoWorkflowModelManagerOptions({
			apiKey: "token",
			cacheIdentity: "cred:9",
			baseUrl: FIXED_BASE_URL,
			cwd: FIXED_CWD,
			namespaceId: FIXED_NAMESPACE_ID,
			projectId: FIXED_PROJECT_ID,
		});

		expect(a.cacheProviderId).not.toBe(b.cacheProviderId);
	});

	it("falls back to apiKey for cacheProviderId when no cacheIdentity is provided", () => {
		const options = gitLabDuoWorkflowModelManagerOptions({
			apiKey: "token",
			baseUrl: FIXED_BASE_URL,
			cwd: FIXED_CWD,
			namespaceId: FIXED_NAMESPACE_ID,
			projectId: FIXED_PROJECT_ID,
		});

		expect(options.cacheProviderId).toBeDefined();
	});

	it("omits cacheProviderId when no credential identity is present", () => {
		const options = gitLabDuoWorkflowModelManagerOptions({
			baseUrl: FIXED_BASE_URL,
			cwd: FIXED_CWD,
			namespaceId: FIXED_NAMESPACE_ID,
			projectId: FIXED_PROJECT_ID,
		});

		expect(options.cacheProviderId).toBeUndefined();
	});
});
