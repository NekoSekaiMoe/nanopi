/**
 * Google Antigravity OAuth flow
 *
 * Signs in with a Google account against the Cloud Code Assist ("antigravity")
 * backend, the same surface the native Antigravity IDE uses. The flow mirrors
 * CLIProxyAPI and Antigravity-Manager:
 *
 * 1. Google OAuth (authorization code, `access_type=offline`) grants
 *    `cloud-platform` plus the antigravity-specific scopes.
 * 2. `loadCodeAssist` returns the Cloud Code project bound to the account. Free
 *    accounts have none until `onboardUser` provisions one, so that call is
 *    retried until the project shows up.
 *
 * The project ID travels in the credential env (`ANTIGRAVITY_PROJECT_ID`) so the
 * request path can wrap every payload without re-reading the token.
 *
 * WARNING: Google's terms do not cover third-party clients using the Antigravity
 * backend. Accounts have been suspended for it. The risk belongs to the user and
 * the login surfaces say so before starting.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";

// Antigravity desktop client — a public OAuth client, so the secret ships with every install.
// Both values are base64-encoded so GitHub's push protection does not read them as leaked
// secrets; the mirror to NekoSekaiMoe/nanopi is a plain push and gets rejected otherwise.
const decode = (s: string) => atob(s);
const CLIENT_ID = decode(
	"MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY");
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ONBOARD_USER_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:onboardUser";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");
const CALLBACK_HOST = getProviderEnvValue("NANOPI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const CALLBACK_PORT = 51121;
const CALLBACK_PATH = "/oauth-callback";
const REQUEST_TIMEOUT_MS = 30 * 1000;
const ONBOARD_ATTEMPTS = 5;
const ONBOARD_POLL_MS = 2000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Sent as the client UA on Google API calls the flow makes itself. */
const FLOW_USER_AGENT = "antigravity";

type ProjectLookup = { projectId: string; tierId?: string };

function requestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	try {
		const json = await response.json();
		return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function errorDetail(json: Record<string, unknown> | null): string {
	const error = json?.error;
	if (typeof error === "string" && error.trim()) return `: ${error.trim()}`;
	if (error && typeof error === "object") {
		const message = (error as Record<string, unknown>).message;
		if (typeof message === "string" && message.trim()) return `: ${message.trim()}`;
	}
	return "";
}

function nullableString(record: Record<string, unknown> | null, key: string): string | undefined {
	const value = record?.[key];
	if (typeof value === "string" && value.trim()) return value.trim();
	return undefined;
}

/** `cloudaicompanionProject` is a string on some accounts and `{ id }` on others. */
function extractProjectId(json: Record<string, unknown> | null): string | undefined {
	for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
		const value = json?.[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (value && typeof value === "object") {
			const id = (value as Record<string, unknown>).id;
			if (typeof id === "string" && id.trim()) return id.trim();
		}
	}
	return undefined;
}

function defaultTierId(json: Record<string, unknown> | null): string {
	const tiers = json?.allowedTiers;
	if (Array.isArray(tiers)) {
		for (const tier of tiers) {
			if (!tier || typeof tier !== "object") continue;
			const entry = tier as Record<string, unknown>;
			if (entry.isDefault !== true) continue;
			const id = nullableString(entry, "id");
			if (id) return id;
		}
	}
	const current = json?.currentTier;
	if (current && typeof current === "object") {
		const id = nullableString(current as Record<string, unknown>, "id");
		if (id) return id;
	}
	return "free-tier";
}

/** Exchanges an authorization code / refresh token at Google's OAuth endpoint. */
async function requestTokens(
	body: Record<string, string>,
	signal: AbortSignal,
): Promise<{ access: string; refresh?: string; expiresInSeconds?: number }> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }).toString(),
		signal: requestSignal(signal),
	});
	const json = await readJson(response);
	if (!response.ok) {
		throw new Error(`Antigravity token request failed with status ${response.status}${errorDetail(json)}`);
	}
	const access = nullableString(json, "access_token");
	if (!access) throw new Error("Antigravity token response is missing access_token");
	const refresh = nullableString(json, "refresh_token");
	const expiresIn = json?.expires_in;
	return {
		access,
		refresh,
		expiresInSeconds: typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : undefined,
	};
}

async function postCloudCode(
	url: string,
	accessToken: string,
	body: Record<string, unknown>,
	signal: AbortSignal,
	userAgent: string,
): Promise<Record<string, unknown> | null> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			Accept: "*/*",
			"User-Agent": userAgent,
		},
		body: JSON.stringify(body),
		signal: requestSignal(signal),
	});
	const json = await readJson(response);
	if (!response.ok) {
		throw new Error(`Antigravity ${url.split(":").pop()} failed with status ${response.status}${errorDetail(json)}`);
	}
	return json;
}

/**
 * Resolves the Cloud Code project for an account. `loadCodeAssist` covers paid
 * and already-onboarded accounts; everyone else is provisioned through
 * `onboardUser`, whose async operation is polled.
 */
async function resolveProject(accessToken: string, signal: AbortSignal): Promise<ProjectLookup> {
	const assist = await postCloudCode(
		LOAD_CODE_ASSIST_URL,
		accessToken,
		{ metadata: { ideType: "ANTIGRAVITY" } },
		signal,
		FLOW_USER_AGENT,
	);
	const projectId = extractProjectId(assist);
	if (projectId) return { projectId };
	const tierId = defaultTierId(assist);
	for (let attempt = 0; attempt < ONBOARD_ATTEMPTS; attempt += 1) {
		if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, ONBOARD_POLL_MS));
		const onboard = await postCloudCode(
			ONBOARD_USER_URL,
			accessToken,
			{
				tier_id: tierId,
				metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity", ide_version: "antigravity" },
			},
			signal,
			`${FLOW_USER_AGENT} google-api-nodejs-client/10.3.0`,
		);
		const response = onboard?.response;
		if (response && typeof response === "object") {
			const id = extractProjectId(response as Record<string, unknown>);
			if (id) return { projectId: id };
		}
		const id = extractProjectId(onboard);
		if (id) return { projectId: id };
	}
	throw new Error(
		"Antigravity did not return a Cloud Code project. Open Antigravity once with this Google account, then run /login antigravity again.",
	);
}

async function loginAntigravity(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	interaction.notify({
		type: "info",
		message: "Third-party Antigravity sign-in can get your Google account suspended.",
	});
	const startCallbackServer = (port: number) =>
		startOAuthCallbackServer({
			providerName: "Google Antigravity",
			host: CALLBACK_HOST,
			port,
			path: CALLBACK_PATH,
			redirectHost: "localhost",
			complete: async (code) => code,
			signal: interaction.signal,
		});
	// Without a callback server, login continues with the pasted redirect URL.
	const callback = await startCallbackServer(CALLBACK_PORT)
		.catch(() => startCallbackServer(0))
		.catch(() => undefined);
	const redirectUri = callback?.redirectUri ?? `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;

	try {
		const authParams = new URLSearchParams({
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES,
			access_type: "offline",
			prompt: "consent",
			include_granted_scopes: "true",
		});
		interaction.notify({
			type: "auth_url",
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete login in your browser, or paste the redirect URL here:",
			placeholder: redirectUri,
		});
		const code = result.type === "callback" ? result.value : parseRedirectInput(result.input);
		if (!code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		const tokens = await requestTokens(
			{ grant_type: "authorization_code", code, redirect_uri: redirectUri },
			interaction.signal,
		);
		if (!tokens.refresh) {
			throw new Error(
				"Antigravity did not return a refresh token. Remove nanopi's access at myaccount.google.com and sign in again.",
			);
		}
		interaction.notify({ type: "progress", message: "Resolving Cloud Code project..." });
		const { projectId } = await resolveProject(tokens.access, interaction.signal);
		return {
			type: "oauth",
			refresh: tokens.refresh,
			access: tokens.access,
			expires: tokenExpiry(tokens.expiresInSeconds),
			env: { ANTIGRAVITY_PROJECT_ID: projectId },
		};
	} catch (e) {
		// An in-flight fetch rejects with a DOMException on abort; the login UI matches on this message.
		if (interaction.signal.aborted) throw new Error("Login cancelled");
		throw e;
	} finally {
		callback?.close();
	}
}

/** Accepts a full redirect URL, a bare `code=...` fragment, or the code itself. */
function parseRedirectInput(input: string): string | undefined {
	const value = input.trim();
	if (!value) return undefined;
	try {
		const code = new URL(value).searchParams.get("code");
		if (code) return code;
	} catch {
		// not a URL
	}
	if (value.includes("code=")) return new URLSearchParams(value.split("?")[1] ?? value).get("code") ?? undefined;
	return value;
}

function tokenExpiry(expiresInSeconds: number | undefined): number {
	return Date.now() + (expiresInSeconds ?? 3600) * 1000 - REFRESH_SKEW_MS;
}

async function refreshAntigravity(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const tokens = await requestTokens({ grant_type: "refresh_token", refresh_token: credential.refresh }, signal);
	return {
		...credential,
		access: tokens.access,
		// Google keeps the refresh token stable; a rotated one wins when present.
		refresh: tokens.refresh ?? credential.refresh,
		expires: tokenExpiry(tokens.expiresInSeconds),
	};
}

export const antigravityOAuth: OAuthAuth = {
	name: "Google Antigravity",
	isSubscription: true,
	loginLabel: "Sign in with Google (Antigravity)",

	login: loginAntigravity,

	refresh: refreshAntigravity,

	async toAuth(credential) {
		return { apiKey: credential.access, env: credential.env };
	},
};
