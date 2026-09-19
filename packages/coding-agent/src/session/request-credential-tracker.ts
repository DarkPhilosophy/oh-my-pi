import type { ApiKey, Model } from "@oh-my-pi/pi-ai";
import { isApiKeyResolver } from "@oh-my-pi/pi-ai";

/** `Agent.getApiKey`: resolves the credential (or credential resolver) for a request. */
export type RequestApiKeyProvider = (model: Model) => Promise<ApiKey | undefined> | ApiKey | undefined;

/**
 * Remembers the bearer each provider request was actually sent with.
 *
 * Recovery paths (usage limits, account-policy denials) must name the account
 * that refused the request, and the marking session id cannot: a subagent
 * streams with the credential resolver its parent handed down, an advisor
 * resolves under its own provider session id, and a provider session re-minted
 * mid-turn leaves nothing sticky under the id recovery marks. Re-resolving
 * after the failure is also wrong — it reports whichever account is selected
 * *now*, which a stream-level rotation or a concurrent turn may already have
 * changed. Recording at resolve time keeps attribution exact: the last bearer a
 * resolver handed out is the one the failing attempt used.
 */
export class RequestCredentialTracker {
	readonly #lastByProvider = new Map<string, string>();

	/** The bearer the most recent request for this provider was sent with. */
	last(provider: string): string | undefined {
		return this.#lastByProvider.get(provider);
	}

	/** Wraps an `Agent.getApiKey` so every resolved bearer is recorded. */
	wrap(getApiKey: RequestApiKeyProvider | undefined): RequestApiKeyProvider | undefined {
		if (!getApiKey) return getApiKey;
		return async model => {
			const resolved = await getApiKey(model);
			if (typeof resolved === "string") {
				this.#lastByProvider.set(model.provider, resolved);
				return resolved;
			}
			if (!isApiKeyResolver(resolved)) return resolved;
			return async ctx => {
				const key = await resolved(ctx);
				if (key) this.#lastByProvider.set(model.provider, key);
				return key;
			};
		};
	}
}
