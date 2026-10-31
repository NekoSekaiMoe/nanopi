/**
 * Qoder OAuth flow (qoder.com / qoder.com.cn subscriptions).
 *
 * Browser approval, not RFC 8628: the flow opens
 * `/device/selectAccounts?nonce=...&challenge=...&challenge_method=S256`, the
 * user approves there, and the CLI polls
 * `/api/v1/deviceToken/poll?nonce=...&verifier=...` until it answers 200 with
 * the device token (`dt-...`). 404 means "not approved yet", so the poll
 * interval is fixed and there is no device code to type anywhere.
 *
 * The device token is what the Qoder API accepts as `Authorization: Bearer`.
 * It carries no expiry this flow can see (the account refresh token is
 * separate and not part of this response), so `expires` is set far out and
 * `refresh` re-reads the account info rather than re-running a token exchange;
 * a token that stops working is a re-login, not a refresh.
 */

import {
	asString,
	qoderErrorDetail,
	qoderRequestSignal,
	readQoderJson,
	resolveQoderRegion,
} from "../../qoder/client.ts";
import { type QoderRegion, qoderEndpoints } from "../../qoder/endpoints.ts";
import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { generatePKCE } from "./pkce.ts";

/** Qoder desktop client id; the same one the official CLI registers with. */
const QODER_CLIENT_ID = "e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb";
const POLL_INTERVAL_MS = 2000;
const DEFAULT_LOGIN_TIMEOUT_SECONDS = 10 * 60;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
/** Tokens do not advertise an expiry; renew the account info daily instead. */
const DEVICE_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

type DeviceToken = { token: string; refreshToken?: string };

function loginTimeoutSeconds(): number {
	const raw = getProviderEnvValue("QODER_OAUTH_TIMEOUT_SECONDS");
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOGIN_TIMEOUT_SECONDS;
}

function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Login cancelled"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Login cancelled"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

async function pollDeviceToken(values: {
	nonce: string;
	verifier: string;
	region: QoderRegion;
	deadline: number;
	signal: AbortSignal;
}): Promise<DeviceToken> {
	const endpoints = qoderEndpoints(values.region);
	const query = new URLSearchParams({
		nonce: values.nonce,
		verifier: values.verifier,
		challenge_method: "S256",
	});
	const url = `${endpoints.pollEndpoint}?${query.toString()}`;

	while (Date.now() < values.deadline) {
		await abortableSleep(POLL_INTERVAL_MS, values.signal);
		if (values.signal.aborted) throw new Error("Login cancelled");
		const response = await fetch(url, {
			method: "GET",
			headers: { accept: "application/json" },
			signal: qoderRequestSignal(values.signal),
		});
		// 404 is the pending answer, not a failure: the browser has not approved yet.
		if (response.status === 404) continue;
		const body = await readQoderJson(response);
		if (!response.ok) {
			throw new Error(`Qoder device token request failed (HTTP ${response.status})${qoderErrorDetail(body)}`);
		}
		const token = asString(body?.token);
		if (!token) throw new Error("Qoder returned no device token");
		return { token, refreshToken: asString(body?.refresh_token) };
	}
	throw new Error("Qoder login timed out");
}

interface QoderAccountInfo {
	name?: string;
	email?: string;
	userId?: string;
	plan?: string;
	userType?: string;
}

async function fetchAccount(token: string, region: QoderRegion, signal: AbortSignal): Promise<QoderAccountInfo> {
	const endpoints = qoderEndpoints(region);
	const response = await fetch(endpoints.userInfo, {
		method: "GET",
		headers: { authorization: `Bearer ${token}`, accept: "application/json" },
		signal: qoderRequestSignal(signal),
	});
	const body = await readQoderJson(response);
	if (response.status === 401 || response.status === 403) {
		throw new Error(`Qoder rejected the device token (HTTP ${response.status}). Sign in again to continue.`);
	}
	if (!response.ok) {
		throw new Error(`Qoder account lookup failed (HTTP ${response.status})${qoderErrorDetail(body)}`);
	}
	const info: QoderAccountInfo = {
		name: asString(body?.name),
		email: asString(body?.email),
		userId: asString(body?.userId) ?? asString(body?.id),
		userType: asString(body?.userType),
	};
	// The plan endpoint is informational: a failure must not fail the login.
	try {
		const planResponse = await fetch(endpoints.plan, {
			method: "GET",
			headers: { authorization: `Bearer ${token}`, accept: "application/json" },
			signal: qoderRequestSignal(signal),
		});
		if (planResponse.ok) info.plan = asString((await readQoderJson(planResponse))?.plan_tier_name);
	} catch {
		// Plan name is cosmetic.
	}
	return info;
}

function credentialFrom(
	token: string,
	refreshToken: string | undefined,
	region: QoderRegion,
	info: QoderAccountInfo,
): OAuthCredential {
	return {
		type: "oauth",
		access: token,
		// The device token is not renewable through a token endpoint, so `refresh`
		// holds the account refresh token when there is one and the device token
		// otherwise (a re-login is the only recovery either way).
		refresh: refreshToken ?? token,
		expires: Date.now() + DEVICE_TOKEN_LIFETIME_MS - REFRESH_SKEW_MS,
		env: {
			QODER_REGION: region,
			...(info.name ? { QODER_ACCOUNT_NAME: info.name } : {}),
			...(info.email ? { QODER_ACCOUNT_EMAIL: info.email } : {}),
			...(info.userId ? { QODER_ACCOUNT_ID: info.userId } : {}),
			...(info.plan ? { QODER_PLAN: info.plan } : {}),
		},
	};
}

async function loginQoder(interaction: ProviderAuthInteraction, region?: QoderRegion): Promise<OAuthCredential> {
	const resolvedRegion = resolveQoderRegion(region);
	const endpoints = qoderEndpoints(resolvedRegion);
	const { verifier, challenge } = await generatePKCE();
	const nonce = randomHex(16);
	const query = new URLSearchParams({
		nonce,
		challenge,
		challenge_method: "S256",
		client_id: QODER_CLIENT_ID,
	});
	try {
		interaction.notify({
			type: "auth_url",
			url: `${endpoints.deviceLoginBase}?${query.toString()}`,
			instructions: `Approve the sign-in for the ${resolvedRegion === "cn" ? "Qoder CN" : "Qoder"} account.`,
		});
		const device = await pollDeviceToken({
			nonce,
			verifier,
			region: resolvedRegion,
			deadline: Date.now() + loginTimeoutSeconds() * 1000,
			signal: interaction.signal,
		});
		interaction.notify({ type: "progress", message: "Reading Qoder account..." });
		const info = await fetchAccount(device.token, resolvedRegion, interaction.signal);
		return credentialFrom(device.token, device.refreshToken, resolvedRegion, info);
	} catch (error) {
		if (interaction.signal.aborted) throw new Error("Login cancelled");
		throw error;
	}
}

/**
 * A stored credential's region: the value login recorded, else the provider
 * default. Two provider ids share this flow, so the region cannot be baked in.
 */
function credentialRegion(credential: OAuthCredential): QoderRegion {
	const stored = credential.env?.QODER_REGION;
	return stored === "cn" || stored === "global" ? stored : resolveQoderRegion();
}

function createQoderOAuth(explicitRegion?: QoderRegion): OAuthAuth {
	return {
		name: explicitRegion === "cn" ? "Qoder (CN)" : "Qoder",
		isSubscription: true,
		loginLabel: explicitRegion === "cn" ? "Sign in with Qoder (qoder.com.cn)" : "Sign in with Qoder",

		login: (interaction) => loginQoder(interaction, explicitRegion),

		// No token endpoint to exchange against; re-read the account to keep the
		// credential fresh and surface a dead token as a refresh failure.
		async refresh(credential, signal) {
			const token = credential.access;
			if (!token) throw new Error("Qoder credential has no device token. Sign in again.");
			const resolvedRegion = credentialRegion(credential);
			const info = await fetchAccount(token, resolvedRegion, signal);
			return credentialFrom(token, credential.refresh, resolvedRegion, info);
		},

		async toAuth(credential) {
			return { apiKey: credential.access, env: credential.env };
		},
	};
}

export const qoderOAuth = createQoderOAuth();
export const qoderCnOAuth = createQoderOAuth("cn");
