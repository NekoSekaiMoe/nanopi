/**
 * Run the Qoder daily check-in against the model runtime's stored credentials.
 *
 * The check-in needs the device token the OAuth login stored, plus the region
 * the login recorded. It reads the credential instead of resolving request auth:
 * `getProviderAuth` refreshes an OAuth credential that is close to expiring, and
 * that refresh retires the stored refresh token, so a check-in would rotate the
 * login every time it ran past the 24h mark for no benefit.
 *
 * A check-in that renews the pair anyway (an expired device token, once the
 * check-in reports 105) stores the rotation before the next account runs.
 */

import type { Credential } from "@nanopi/pi-ai";
import {
	checkinQoder,
	type QoderCheckinOptions,
	type QoderDeviceIdentity,
	type QoderRegion,
	qoderEndpoints,
	resolveQoderRegion,
} from "@nanopi/pi-ai/qoder";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { QODER_PROVIDER_IDS } from "./constants.ts";

export interface QoderCheckinSummary {
	provider: string;
	/** Account name recorded at login, when the credential carries one. */
	account?: string;
	/** `none` is a provider this build does not register; it is not reported. */
	status: "claimed" | "already_claimed" | "no_campaign" | "error" | "unconfigured" | "none";
	amount: number;
	/** Campaign window the result belongs to (`YYYY-MM-DD`), when the server reported one. */
	windowDate?: string;
	message: string;
}

/** Windows a machine already finished; the daily one rolls over at 10:00 Beijing time. */
const finishedWindows = new Map<string, string>();

function regionForProvider(provider: string): QoderRegion {
	return provider === "qoder-cn" ? "cn" : "global";
}

/** `qoder-cn` is region `cn` even when the credential does not record one. */
function credentialRegion(provider: string, stored: string | undefined): QoderRegion {
	return stored === "cn" || stored === "global" ? stored : resolveQoderRegion(regionForProvider(provider));
}

/** The device token a stored Qoder login carries; an api-key credential has none. */
function credentialToken(credential: Credential | undefined): string | undefined {
	if (credential?.type !== "oauth") return undefined;
	return credential.access.length > 0 ? credential.access : undefined;
}

/**
 * Device identity to send. Only the global site withholds its campaign from a
 * request that carries none, and only a captured identity helps (an invented
 * one is what the CN site rejects), so a CN account never sends one.
 */
function deviceIdentity(region: QoderRegion, env: Record<string, string> | undefined) {
	if (region === "cn") return undefined;
	const machineToken = env?.QODER_MACHINE_TOKEN ?? process.env.QODER_MACHINE_TOKEN;
	const machineType = env?.QODER_MACHINE_TYPE ?? process.env.QODER_MACHINE_TYPE;
	if (!machineToken && !machineType) return undefined;
	const device: QoderDeviceIdentity = { machineToken, machineType };
	return device;
}

function checkinOptions(provider: string, region: QoderRegion, env: Record<string, string> | undefined) {
	return {
		device: deviceIdentity(region, env),
		previousWindowDate: finishedWindows.get(provider),
	} satisfies QoderCheckinOptions;
}

/**
 * A check-in that claims the window this machine already finished tells the
 * user nothing: it is the startup check before 10:00, and the session that
 * starts after the rollover claims the new one anyway.
 */
function finishWindow(provider: string, windowDate: string | undefined): void {
	if (windowDate) finishedWindows.set(provider, windowDate);
}

export async function runQoderCheckin(
	modelRegistry: ModelRegistry,
	signal: AbortSignal,
): Promise<QoderCheckinSummary[]> {
	const credentials = await modelRegistry.listCredentials({ signal });
	const loggedIn = new Set(credentials.map((entry) => entry.providerId));

	const summaries: QoderCheckinSummary[] = [];
	for (const provider of QODER_PROVIDER_IDS) {
		if (!modelRegistry.hasProvider(provider)) {
			summaries.push({ provider, status: "none", amount: 0, message: "provider not in this build" });
			continue;
		}
		if (!loggedIn.has(provider)) {
			summaries.push({ provider, status: "none", amount: 0, message: "not logged in" });
			continue;
		}
		const stored = await modelRegistry.readCredential(provider, { signal });
		const token = credentialToken(stored);
		const env = stored?.env as Record<string, string> | undefined;
		if (!token) {
			summaries.push({
				provider,
				status: "unconfigured",
				amount: 0,
				message: "credential has no device token",
			});
			continue;
		}
		const region = credentialRegion(provider, env?.QODER_REGION);
		const account = env?.QODER_ACCOUNT_NAME ?? env?.QODER_ACCOUNT_EMAIL;
		try {
			const result = await checkinQoder(
				token,
				qoderEndpoints(region),
				checkinOptions(provider, region, env),
				signal,
			);
			finishWindow(provider, result.windowDate);
			summaries.push({
				provider,
				account,
				status: result.status,
				amount: result.amount,
				windowDate: result.windowDate,
				message: result.message,
			});
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
