import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadKiroOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { KIRO_MODELS } from "./kiro.models.ts";

export function kiroProvider(): Provider<"anthropic-messages"> {
	return createProvider({
		id: "kiro",
		name: "Kiro",
		baseUrl: "https://q.us-east-1.amazonaws.com/generateAssistantResponse",
		auth: {
			apiKey: envApiKeyAuth("Kiro API key", ["KIRO_API_KEY"]),
			oauth: lazyOAuth({
				name: "Kiro (AWS)",
				isSubscription: true,
				loginLabel: "Sign in with Kiro",
				load: loadKiroOAuth,
			}),
		},
		models: Object.values(KIRO_MODELS),
		api: anthropicMessagesApi(),
	});
}
