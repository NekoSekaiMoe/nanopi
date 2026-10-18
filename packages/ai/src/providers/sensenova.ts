import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { SENSENOVA_MODELS } from "./sensenova.models.ts";

export function sensenovaProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "sensenova",
		name: "SenseNova",
		baseUrl: "https://token.sensenova.cn/v1",
		auth: { apiKey: envApiKeyAuth("SenseNova API key", ["SENSENOVA_API_KEY"]) },
		models: Object.values(SENSENOVA_MODELS),
		api: openAICompletionsApi(),
	});
}
