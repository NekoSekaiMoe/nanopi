import { openAIDecisionsApi } from "../api/openai-decisions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAIChatGPTOAuth } from "../auth/oauth/load.ts";
import type { OAuthCredential } from "../auth/types.ts";
import { createProvider, isModelType, type Provider } from "../models.ts";
import type { ClassifierModel } from "../types.ts";
import { OPENAI_CLASSIFIER_MODELS, OPENAI_MODELS } from "./openai.models.ts";

/** Account catalog captured by the ChatGPT OAuth flow, or undefined when the account has no answer yet. */
function chatGPTModelIds(credential: OAuthCredential): Set<string> | undefined {
	const modelIds = credential.modelIds;
	if (!Array.isArray(modelIds) || !modelIds.every((id) => typeof id === "string")) return undefined;
	return new Set(modelIds);
}

export function openaiProvider(): Provider<"openai-responses"> {
	return createProvider<"openai-responses">({
		id: "openai",
		name: "OpenAI",
		baseUrl: "https://api.openai.com/v1",
		auth: {
			apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]),
			oauth: lazyOAuth({
				name: "OpenAI (ChatGPT subscription)",
				isSubscription: true,
				loginLabel: "Sign in with ChatGPT",
				load: loadOpenAIChatGPTOAuth,
			}),
		},
		models: [
			...Object.values(OPENAI_MODELS),
			...Object.values<ClassifierModel<"openai-decisions">>(OPENAI_CLASSIFIER_MODELS),
		],
		// Sign in with ChatGPT tokens only reach the Responses API, so the Decisions API models stay
		// hidden. The same credential carries the account's model catalog: a Free plan cannot reach
		// the paid tiers in the bundled list, and offering them means a failure on the first turn.
		filterAllModels: (models, credential) => {
			if (credential?.type !== "oauth") return models;
			const availableIds = chatGPTModelIds(credential);
			return models.filter(
				(model) => !isModelType(model, "classifier") && (!availableIds || availableIds.has(model.id)),
			);
		},
		api: openAIResponsesApi(),
		classifiers: {
			"openai-decisions": openAIDecisionsApi(),
		},
	});
}
