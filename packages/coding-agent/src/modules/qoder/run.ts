/**
 * Run the Qoder daily check-in against the model runtime's stored credentials.
 *
 * The check-in needs the device token the OAuth login stored, plus the region
 * the login recorded. `modelRegistry.getProviderAuth` is what hands both over:
 * it resolves (and refreshes, when due) the stored credential for one provider
 * and nothing else, so an unconfigured provider costs no request.
 */

import { checkinQoder, type QoderRegion, qoderEndpoints, resolveQoderRegion } from "@nanopi/pi-ai/qoder";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { QODER_PROVIDER_IDS } from "./constants.ts";

export interface QoderCheckinSummary {
	provider: string;
	/** Account name recorded at login, when the credential carries one. */
	account?: string;
	/** `none` is a provider this build does not register; it is not reported. */
	status: "claimed" | "already_claimed" | "no_campaign" | "error" | "unconfigured" | "none";
	amount: number;
	message: string;
}

function regionForProvider(provider: string): QoderRegion {
	return provider === "qoder-cn" ? "cn" : "global";
}

/** `qoder-cn` is region `cn` even when the credential does not record one. */
function credentialRegion(provider: string, stored: string | undefined): QoderRegion {
	return stored === "cn" || stored === "global" ? stored : resolveQoderRegion(regionForProvider(provider));
}

export async function runQoderCheckin(
	modelRegistry: ModelRegistry,
	signal: AbortSignal,
): Promise<QoderCheckinSummary[]> {
	const registered = new Set(modelRegistry.getRegisteredProviderIds());
	const credentials = await modelRegistry.listCredentials({ signal });
	const loggedIn = new Set(credentials.map((entry) => entry.providerId));

	const summaries: QoderCheckinSummary[] = [];
	for (const provider of QODER_PROVIDER_IDS) {
		if (!registered.has(provider)) {
			summaries.push({ provider, status: "none", amount: 0, message: "provider not in this build" });
			continue;
		}
		if (!loggedIn.has(provider)) {
			summaries.push({ provider, status: "none", amount: 0, message: "not logged in" });
			continue;
		}
		const credential = await modelRegistry.getProviderAuth(provider);
		const token = credential?.auth.apiKey;
		if (!token) {
			summaries.push({
				provider,
				status: "unconfigured",
				amount: 0,
				message: "credential has no device token",
			});
			continue;
		}
		const region = credentialRegion(provider, credential.env?.QODER_REGION);
		const account = credential.env?.QODER_ACCOUNT_NAME ?? credential.env?.QODER_ACCOUNT_EMAIL;
		try {
			const result = await checkinQoder(token, qoderEndpoints(region), signal);
			summaries.push({ provider, account, status: result.status, amount: result.amount, message: result.message });
		} catch (error) {
			summaries.push({
				provider,
				account,
				status: "error",
				amount: 0,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return summaries;
}
