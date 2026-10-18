import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { ZHIPUAI_MODELS } from "./zhipuai.models.ts";

export function zhipuaiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "zhipuai",
		name: "Zhipu AI",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		auth: { apiKey: envApiKeyAuth("Zhipu AI API key", ["ZHIPU_API_KEY"]) },
		models: Object.values(ZHIPUAI_MODELS),
		api: openAICompletionsApi(),
	});
}
