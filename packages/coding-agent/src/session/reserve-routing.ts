import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { ApiKey, AuthStorage, Model, OAuthAccessResolution } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

/** Only the credential store can bind quota evidence to the OAuth row used on the wire. */
type ReserveCredentials = Pick<
	AuthStorage,
	"getReserveCredential" | "getOAuthAccessByCredentialId" | "rejectReserveCredential"
>;

/** Preserve the user's logical selection; only one request uses the equivalent reserve model. */
export function createReserveRoutingStreamFn(
	settings: Settings,
	auth: ReserveCredentials,
	base: StreamFn,
	getNormalApiKey: (model: Model) => ApiKey | undefined | Promise<ApiKey | undefined>,
): StreamFn {
	return async (model, context, options) => {
		const route = model.reserveRoute;
		if (!route || model.id === route.model || !settings.get("providers.openai-codex.useReserve")) {
			return base(model, context, options);
		}
		const outer = new AssistantMessageEventStream();
		const run = async (): Promise<void> => {
			const attempted = new Set<number>();
			let started = false;
			const reserveModel: Model = {
				...model,
				id: route.model,
				requestModelId: route.model,
				reserveRoute: undefined,
				thinking: model.thinking ? { ...model.thinking, effortRouting: undefined } : undefined,
			};
			while (true) {
				options?.signal?.throwIfAborted();
				let observation: { credentialId: number; observedAt: number } | undefined;
				try {
					observation = await auth.getReserveCredential(model.provider, route, {
						sessionId: options?.sessionId,
						signal: options?.signal,
						excludeCredentialIds: attempted,
					});
				} catch {
					options?.signal?.throwIfAborted();
					logger.debug("Reserve quota unavailable; using selected model", { provider: model.provider });
					break;
				}
				if (!observation || attempted.has(observation.credentialId)) break;
				attempted.add(observation.credentialId);
				let access: OAuthAccessResolution | undefined;
				try {
					access = await auth.getOAuthAccessByCredentialId(model.provider, observation.credentialId);
				} catch {
					options?.signal?.throwIfAborted();
					continue;
				}
				options?.signal?.throwIfAborted();
				if (!access?.ok) continue;
				let content = false;
				let retry = false;
				const reserve = await base(reserveModel, context, { ...options, apiKey: access.accessToken });
				for await (const event of reserve) {
					if (event.type === "start") {
						if (!started) outer.push(event);
						started = true;
						continue;
					}
					if (
						event.type === "error" &&
						event.error.stopReason !== "aborted" &&
						!options?.signal?.aborted &&
						(AIError.isAuthRetryableError(event.error) || AIError.status(event.error) === 404)
					) {
						auth.rejectReserveCredential(model.provider, route, observation);
						if (!content) {
							retry = true;
							break;
						}
					}
					if (event.type !== "error" && event.type !== "done") content = true;
					outer.push(event);
				}
				if (!retry) return;
			}
			options?.signal?.throwIfAborted();
			const normal = await base(model, context, { ...options, apiKey: await getNormalApiKey(model) });
			for await (const event of normal) {
				if (event.type === "start" && started) continue;
				outer.push(event);
			}
		};
		void run().catch(error => {
			if (!outer.done) outer.fail(error);
		});
		return outer;
	};
}
