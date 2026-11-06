import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MOONSHOTAI_MODELS } from "./moonshotai.models.ts";

/**
 * Moonshot AI. One provider covers both endpoints: `moonshotai-cn` was the same
 * models (same ids, same prices) behind `https://api.moonshot.cn/v1`, which is
 * the only thing that differed, so the China endpoint is a `models.json` base
 * URL override rather than a second catalog.
 */
export function moonshotaiProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "moonshotai",
		name: "Moonshot AI",
		baseUrl: "https://api.moonshot.ai/v1",
		auth: { apiKey: envApiKeyAuth("Moonshot AI API key", ["MOONSHOT_API_KEY"]) },
		models: Object.values(MOONSHOTAI_MODELS),
		api: openAICompletionsApi(),
	});
}
