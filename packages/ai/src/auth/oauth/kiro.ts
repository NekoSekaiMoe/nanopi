/**
 * Kiro (AWS) OAuth flow
 *
 * Kiro is AWS's agent IDE. Its sign-in is the builder-id flow the AWS CLI uses:
 * a device authorization grant (RFC 8628) against AWS SSO OIDC, with the token
 * exchanged for a Kiro API key that authenticates requests to
 * https://q.<region>.amazonaws.com/generateAssistantResponse.
 *
 * The AWS endpoints need no registered client: `registerClient` creates one for
 * this installation, which is also why the region is picked first (Kiro's
 * enterprise installs live in their own region). `refresh` re-runs the token
 * call with `refreshToken`, and re-registers the client under the region stored
 * on the credential when the original registration is gone.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { pollOAuthDeviceCodeFlow } from "./device-code.ts";

/** Kiro's public builder-id client name; AWS shows it on the consent page. */
const CLIENT_NAME = "kiro-oauth-client";
const CLIENT_TYPE = "public";
const DEFAULT_REGION = "us-east-1";
const OAUTH_SCOPES = ["codewhisperer:completions", "codewhisperer:analysis", "codewhisperer:conversations"];
const BUILDERS_ID_START_URL = "https://view.awsapps.com/start";
const DEVICE_CODE_TIMEOUT_SECONDS = 10 * 60;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

type JsonObject = Record<string, unknown>;

type KiroRegion = {
	oauthEndpoint: string;
	apiEndpoint: string;
};

/** Custom (enterprise) installs answer on their own region; the ids are per region. */
const KIRO_REGIONS: Record<string, KiroRegion> = {
	"us-east-1": {
		oauthEndpoint: "https://prod.us-east-1.auth.desktop.kiro.dev",
		apiEndpoint: "https://q.us-east-1.amazonaws.com",
	},
	"eu-central-1": {
		oauthEndpoint: "https://prod.eu-central-1.auth.desktop.kiro.dev",
		apiEndpoint: "https://q.eu-central-1.amazonaws.com",
	},
};

type DeviceAuthorization = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	intervalSeconds?: number;
	expiresInSeconds: number;
	clientId: string;
	clientSecret: string;
	region: string;
};

function getRegion(): string {
	const override = getProviderEnvValue("KIRO_REGION");
	return override && override.length > 0 ? override : DEFAULT_REGION;
}

function regionEndpoints(region: string): KiroRegion {
	const known = KIRO_REGIONS[region];
	// An unlisted region is an enterprise install; its endpoints follow the
	// naming scheme the two known ones use.
	return (
		known ?? {
			oauthEndpoint: `https://prod.${region}.auth.desktop.kiro.dev`,
			apiEndpoint: `https://q.${region}.amazonaws.com`,
		}
	);
}

function requestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

async function readJson(response: Response): Promise<JsonObject | null> {
	try {
		const json = await response.json();
		return json && typeof json === "object" ? (json as JsonObject) : null;
	} catch {
		return null;
	}
}

async function postJson(
	url: string,
	body: JsonObject,
	signal: AbortSignal,
): Promise<{ ok: boolean; status: number; body: JsonObject | null }> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(body),
			signal: requestSignal(signal),
		});
	} catch (error) {
		if (signal.aborted) throw new Error("Login cancelled");
		throw error;
	}
	return { ok: response.ok, status: response.status, body: await readJson(response) };
}

/** The verification URI is opened in the user's browser; only http(s) URLs are trusted. */
function trustedHttpUrl(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
	} catch {
		return undefined;
	}
}

function requiredString(body: JsonObject | null, field: string, operation: string): string {
	const value = body?.[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`Kiro ${operation} response is missing ${field}: ${JSON.stringify(body)}`);
	}
	return value;
}

async function registerClient(
	oauthEndpoint: string,
	signal: AbortSignal,
): Promise<{ clientId: string; clientSecret: string }> {
	const response = await postJson(
		`${oauthEndpoint}/client/register`,
		{
			clientName: CLIENT_NAME,
			clientType: CLIENT_TYPE,
			scopes: OAUTH_SCOPES,
			grantTypes: ["device_code", "refresh_token"],
		},
		signal,
	);
	if (!response.ok) {
		throw new Error(`Kiro client registration failed with status ${response.status}`);
	}
	return {
		clientId: requiredString(response.body, "clientId", "client registration"),
		clientSecret: requiredString(response.body, "clientSecret", "client registration"),
	};
}

async function startDeviceAuthorization(
	oauthEndpoint: string,
	client: { clientId: string; clientSecret: string },
	region: string,
	signal: AbortSignal,
): Promise<DeviceAuthorization> {
	const response = await postJson(
		`${oauthEndpoint}/device_authorization`,
		{ clientId: client.clientId, clientSecret: client.clientSecret, startUrl: BUILDERS_ID_START_URL },
		signal,
	);
	if (!response.ok) {
		throw new Error(`Kiro device authorization failed with status ${response.status}`);
	}
	const body = response.body;
	const expiresIn = body?.expiresIn;
	const interval = body?.interval;
	return {
		deviceCode: requiredString(body, "deviceCode", "device authorization"),
		userCode: requiredString(body, "userCode", "device authorization"),
		verificationUri:
			trustedHttpUrl(body?.verificationUri) ?? requiredString(body, "verificationUri", "device authorization"),
		verificationUriComplete: trustedHttpUrl(body?.verificationUriComplete),
		intervalSeconds: typeof interval === "number" && interval > 0 ? interval : undefined,
		expiresInSeconds:
			typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
				? expiresIn
				: DEVICE_CODE_TIMEOUT_SECONDS,
		clientId: client.clientId,
		clientSecret: client.clientSecret,
		region,
	};
}

function credentialFromPoll(body: JsonObject, device: DeviceAuthorization): OAuthCredential {
	const access = requiredString(body, "accessToken", "device token");
	const refresh = requiredString(body, "refreshToken", "device token");
	const expiresIn = body.expiresIn;
	return {
		type: "oauth",
		access,
		refresh,
		expires:
			Date.now() +
			(typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000,
		clientId: device.clientId,
		clientSecret: device.clientSecret,
		region: device.region,
	};
}

async function pollForCredential(
	oauthEndpoint: string,
	device: DeviceAuthorization,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	return pollOAuthDeviceCodeFlow<OAuthCredential>({
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
		waitBeforeFirstPoll: true,
		signal,
		poll: async () => {
			const response = await postJson(
				`${oauthEndpoint}/token`,
				{
					clientId: device.clientId,
					clientSecret: device.clientSecret,
					deviceCode: device.deviceCode,
					grantType: "urn:ietf:params:oauth:grant-type:device_code",
				},
				signal,
			);
			if (response.ok && typeof response.body?.accessToken === "string") {
				return { status: "complete", value: credentialFromPoll(response.body, device) };
			}

			const error = response.body?.error;
			if (error === "authorization_pending") return { status: "pending" };
			if (error === "slow_down") {
				const interval = response.body?.interval;
				return { status: "slow_down", intervalSeconds: typeof interval === "number" ? interval : undefined };
			}
			if (error === "expired_token") {
				return { status: "failed", message: "Kiro device code expired. Please restart login." };
			}
			if (error === "access_denied") {
				return { status: "failed", message: "Kiro login was denied." };
			}
			return {
				status: "failed",
				message: `Kiro device token request failed with status ${response.status}${
					typeof error === "string" ? `: ${error}` : ""
				}`,
			};
		},
	});
}

async function loginKiro(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const region = getRegion();
	const { oauthEndpoint } = regionEndpoints(region);
	const client = await registerClient(oauthEndpoint, interaction.signal);
	const device = await startDeviceAuthorization(oauthEndpoint, client, region, interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: device.userCode,
		verificationUri: device.verificationUriComplete ?? device.verificationUri,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	return pollForCredential(oauthEndpoint, device, interaction.signal);
}

async function refreshKiroToken(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const region =
		typeof credential.region === "string" && credential.region.length > 0 ? credential.region : getRegion();
	const { oauthEndpoint } = regionEndpoints(region);
	const clientId = credential.clientId;
	const clientSecret = credential.clientSecret;
	// A credential stored by an earlier version has the token but not the client
	// registration it was issued to; without both there is nothing to refresh to.
	if (typeof clientId !== "string" || typeof clientSecret !== "string") {
		throw new Error("Kiro credential has no client registration. Please sign in again.");
	}

	const response = await postJson(
		`${oauthEndpoint}/token`,
		{ clientId, clientSecret, refreshToken: credential.refresh, grantType: "refresh_token" },
		signal,
	);
	if (!response.ok) {
		throw new Error(`Kiro token refresh failed with status ${response.status}`);
	}
	const access = requiredString(response.body, "accessToken", "token refresh");
	const refresh = requiredString(response.body, "refreshToken", "token refresh");
	const expiresIn = response.body?.expiresIn;
	return {
		...credential,
		access,
		refresh,
		expires:
			Date.now() +
			(typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000 -
			REFRESH_SKEW_MS,
	};
}

export const kiroOAuth: OAuthAuth = {
	name: "Kiro (AWS)",
	isSubscription: true,
	loginLabel: "Sign in with Kiro",

	login: loginKiro,

	refresh: refreshKiroToken,

	async toAuth(credential) {
		return { apiKey: credential.access };
	},
};
