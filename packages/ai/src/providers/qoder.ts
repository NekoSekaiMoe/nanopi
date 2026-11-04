import { qoderApi } from "../api/qoder.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadQoderCnOAuth, loadQoderOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider, type RefreshModelsContext } from "../models.ts";
import { fetchQoderModelList, type QoderAccountSession, qoderModelEntry } from "../qoder/catalog.ts";
import { type QoderApi, type QoderRegion, qoderEndpoints } from "../qoder/endpoints.ts";
import type { Model } from "../types.ts";

/**
 * Qoder sells a subscription over a signed agent endpoint, so the usable
 * models are whatever the account's list endpoint answers. There is no
 * packaged catalog: the only entry every account is known to have is `auto`,
 * which keeps `/model` non-empty before the first refresh and gives the live
 * fetch something to replace.
 */

/** The single entry the list endpoint is not needed for. */
function autoModel(provider: "qoder" | "qoder-cn"): Model<QoderApi> {
	return qoderModelEntry({
		provider,
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
): (context: RefreshModelsContext) => Promise<readonly Model<QoderApi>[]> {
	return async (context) => {
		const account = accountFromEnv(context.credential?.type === "oauth" ? context.credential.env : undefined);
		if (!account) return [];
		const listed = await fetchQoderModelList(region, account, context.signal);
		return listed.map((entry) => qoderModelEntry({ provider, listed: entry }));
	};
}

function qoder(provider: "qoder" | "qoder-cn"): Provider<QoderApi> {
	const region: QoderRegion = provider === "qoder-cn" ? "cn" : "global";
	const label = provider === "qoder-cn" ? "Qoder CN" : "Qoder";
	return createProvider({
		id: provider,
		name: label,
		baseUrl: qoderEndpoints(region).chatUrl,
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
		api: qoderApi(),
	});
}

export function qoderProvider(): Provider<QoderApi> {
	return qoder("qoder");
}

export function qoderCnProvider(): Provider<QoderApi> {
	return qoder("qoder-cn");
}
