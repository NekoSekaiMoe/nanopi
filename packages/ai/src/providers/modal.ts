import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { MODAL_MODELS } from "./modal.models.ts";

export function modalProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "modal",
		name: "Modal",
		baseUrl: "https://inference.us-west.modal.direct/v1",
		auth: { apiKey: envApiKeyAuth("Modal proxy token", ["MODAL_PROXY_TOKEN"]) },
		models: Object.values(MODAL_MODELS),
		api: openAICompletionsApi(),
	});
}
