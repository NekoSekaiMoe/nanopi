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

/**
 * What a Qoder sign-in does not do for the account: the daily check-in pays only
 * a request that looks like an official installation, and the one header that
 * cannot be derived is the machine token. The dialog is the one place the user
 * reads before filling in an env the flow itself cannot validate.
 */
const CHECKIN_NOTICE: readonly string[] = [
	"Signing in does not configure the daily check-in: without a captured device identity the global site withholds the campaign that pays it.",
	"Capture `cosy-machinetoken`, `cosy-machinetype` and `cosy-version` from the desktop client (proxy it, open the usage panel, read the request to /sash/api/v1/me/campaigns) and store them as QODER_MACHINE_TOKEN, QODER_MACHINE_TYPE and QODER_CLIENT_VERSION on this credential.",
	"An invented value is worse than none: the CN site rejects a forged fingerprint and the global site stops issuing the campaign. The status line of /qoder-checkin says which fields the request actually carried.",
	"Without one in the credential the check-in falls back to the same variables in the environment, so a single capture on this machine is shared by every account signed in here.",
];

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
				// The CN site hands the daily campaign to the account without a fingerprint; the caveat is the global one.
				notice: provider === "qoder-cn" ? undefined : CHECKIN_NOTICE,
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
