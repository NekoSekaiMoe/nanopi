import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OLLAMA_CLOUD_TOKEN_PLAN_MODELS } from "./ollama-cloud-token-plan.models.ts";

export function ollamaCloudTokenPlanProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "ollama-cloud-token-plan",
		name: "Ollama Cloud Token Plan",
		baseUrl: "https://ollama.com/v1",
		auth: { apiKey: envApiKeyAuth("Ollama Cloud token plan key", ["OLLAMA_CLOUD_TOKEN_PLAN_API_KEY"]) },
		models: Object.values(OLLAMA_CLOUD_TOKEN_PLAN_MODELS),
		api: openAICompletionsApi(),
	});
}
