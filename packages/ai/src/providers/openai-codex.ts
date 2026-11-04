import { openAICodexResponsesApi } from "../api/openai-codex-responses.lazy.ts";
import { lazyOAuth } from "../auth/helpers.ts";
import { loadOpenAICodexOAuth } from "../auth/oauth/load.ts";
import type { OAuthCredential } from "../auth/types.ts";
import { createProvider, type Provider } from "../models.ts";
import { OPENAI_CODEX_MODELS } from "./openai-codex.models.ts";

/** Account catalog captured by the ChatGPT OAuth flow, or undefined when the account has no answer yet. */
function chatGPTModelIds(credential: OAuthCredential): Set<string> | undefined {
	const modelIds = credential.modelIds;
	if (!Array.isArray(modelIds) || !modelIds.every((id) => typeof id === "string")) return undefined;
	return new Set(modelIds);
}

export function openaiCodexProvider(): Provider<"openai-codex-responses"> {
	return createProvider({
		id: "openai-codex",
		name: "OpenAI Codex (legacy)",
		baseUrl: "https://chatgpt.com/backend-api",
		auth: {
			oauth: lazyOAuth({
				name: "OpenAI (ChatGPT Plus/Pro)",
				isSubscription: true,
				load: loadOpenAICodexOAuth,
			}),
		},
		models: Object.values(OPENAI_CODEX_MODELS),
		// The bundled list carries every ChatGPT tier, but an account only reaches part of it: a Free
		// plan cannot use the paid ones. The credential holds the catalog `GET /models` reported for
		// that account, so offering anything outside it means a failure on the first turn. Without a
		// catalog (not answered yet, offline) the full bundled list stays.
		filterModels: (models, credential) => {
			if (credential?.type !== "oauth") return models;
			const availableIds = chatGPTModelIds(credential);
			return availableIds ? models.filter((model) => availableIds.has(model.id)) : models;
		},
		api: openAICodexResponsesApi(),
	});
}
