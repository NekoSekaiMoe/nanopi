import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadQoderCnOAuth, loadQoderOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { qoderEndpoints } from "../qoder/endpoints.ts";
import { QODER_MODELS } from "./qoder.models.ts";
import { QODER_CN_MODELS } from "./qoder-cn.models.ts";

// Qoder's OpenAI-compatible gateway serves both sites; only the host differs.
const GATEWAY_PATH = "/v1";

export function qoderProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qoder",
		name: "Qoder",
		baseUrl: `https://${qoderEndpoints("global").openApiHost}${GATEWAY_PATH}`,
		auth: {
			apiKey: envApiKeyAuth("Qoder device token", ["QODER_DEVICE_TOKEN"]),
			oauth: lazyOAuth({
				name: "Qoder",
				isSubscription: true,
				loginLabel: "Sign in with Qoder",
				load: loadQoderOAuth,
			}),
		},
		models: Object.values(QODER_MODELS),
		api: openAICompletionsApi(),
	});
}

export function qoderCnProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "qoder-cn",
		name: "Qoder CN",
		baseUrl: `https://${qoderEndpoints("cn").openApiHost}${GATEWAY_PATH}`,
		auth: {
			apiKey: envApiKeyAuth("Qoder CN device token", ["QODER_CN_DEVICE_TOKEN"]),
			oauth: lazyOAuth({
				name: "Qoder (CN)",
				isSubscription: true,
				loginLabel: "Sign in with Qoder (qoder.com.cn)",
				load: loadQoderCnOAuth,
			}),
		},
		models: Object.values(QODER_CN_MODELS),
		api: openAICompletionsApi(),
	});
}
