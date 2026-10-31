import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadQoderCnOAuth, loadQoderOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import { fetchQoderModelList, type QoderAccountSession, qoderModelEntry } from "../qoder/catalog.ts";
import { type QoderRegion, qoderEndpoints } from "../qoder/endpoints.ts";
import type { Model } from "../types.ts";

/**
 * Qoder serves inference behind `/algo` signed endpoints and sells it as a
 * subscription, so the usable models are whatever the account's list endpoint
 * answers. There is no packaged catalog: the only model every account is known
 * to have is `auto`, which keeps `/model` non-empty before the first refresh
 * and gives the live fetch something to replace.
 */

/** The single entry the list endpoint is not needed for. */
function autoModel(provider: "qoder" | "qoder-cn"): Model<"openai-completions"> {
	return qoderModelEntry({
		provider,
		baseUrl: `https://${qoderEndpoints(provider === "qoder-cn" ? "cn" : "global").openApiHost}/v1`,
		listed: { key: "auto", displayName: "Qoder Auto", isDefault: true, isReasoning: false, contextWindow: 200000 },
	});
}

/**
 * Login records the account id in the credential env; the signed list call
 * needs it to derive the device headers, so a credential without one cannot
 * refresh and leaves the packaged `auto` entry in place.
 */
function accountFromEnv(env: Record<string, string> | undefined): QoderAccountSession | undefined {
	const uid = env?.QODER_ACCOUNT_ID;
	const token = env?.QODER_DEVICE_TOKEN;
	if (!uid || !token) return undefined;
	return {
		uid,
		token,
		name: env?.QODER_ACCOUNT_NAME,
		organizationId: env?.QODER_ACCOUNT_ORG_ID,
		organizationName: env?.QODER_ACCOUNT_ORG_NAME,
		userType: env?.QODER_ACCOUNT_USER_TYPE,
		refreshToken: env?.QODER_ACCOUNT_REFRESH_TOKEN,
	};
}

function liveModels(
	provider: "qoder" | "qoder-cn",
	region: QoderRegion,
): (context: RefreshModelsContext) => Promise<readonly Model<"openai-completions">[]> {
	const baseUrl = `https://${qoderEndpoints(region).openApiHost}/v1`;
	return async (context) => {
		const account = accountFromEnv(context.credential?.type === "oauth" ? context.credential.env : undefined);
		if (!account) return [];
		const listed = await fetchQoderModelList(region, account, context.signal);
		return listed.map((entry) => qoderModelEntry({ provider, baseUrl, listed: entry }));
	};
}

function qoder(provider: "qoder" | "qoder-cn"): Provider<"openai-completions"> {
	const region: QoderRegion = provider === "qoder-cn" ? "cn" : "global";
	const label = provider === "qoder-cn" ? "Qoder CN" : "Qoder";
	return createProvider({
		id: provider,
		name: label,
		baseUrl: `https://${qoderEndpoints(region).openApiHost}/v1`,
		auth: {
			apiKey: envApiKeyAuth(`${label} device token`, [
				provider === "qoder-cn" ? "QODER_CN_DEVICE_TOKEN" : "QODER_DEVICE_TOKEN",
			]),
			oauth: lazyOAuth({
				name: label,
				isSubscription: true,
				loginLabel: provider === "qoder-cn" ? "Sign in with Qoder (qoder.com.cn)" : "Sign in with Qoder",
				load: provider === "qoder-cn" ? loadQoderCnOAuth : loadQoderOAuth,
			}),
		},
		models: [autoModel(provider)],
		fetchModels: liveModels(provider, region),
		api: openAICompletionsApi(),
	});
}

export function qoderProvider(): Provider<"openai-completions"> {
	return qoder("qoder");
}

export function qoderCnProvider(): Provider<"openai-completions"> {
	return qoder("qoder-cn");
}
