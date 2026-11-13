/**
 * Renewing the Qoder device token with the account refresh token.
 *
 * A Qoder login hands out two strings: the device token (`dt-...`) every
 * request carries, and an account refresh token (`drt-...`). Both expire. The
 * signed `/algo` endpoints answer an expired device token inside the stream
 * (`statusCodeValue: 403`, body `{"code":"105","message":"Login expired"}`),
 * which reads as a generic provider failure unless something renews the token.
 *
 * `POST /algo/api/v3/user/jobToken?Encode=1` is the endpoint that renews it.
 * It is not a signed call: the `signature`/`date` pair is the client's own
 * constant, and the token being redeemed travels inside a body encoded with
 * `/Encode=1`'s alphabet. Sending the refresh token under `needRefresh` gets
 * a new device token *and* a new refresh token, which is why the caller has to
 * store both: the old refresh token dies with the exchange.
 *
 * The exchange answers 401 to a request that carries no device headers, so the
 * three `cosy-machine*` headers are part of the contract even though the token
 * is what is being redeemed. They are derived from the credential rather than
 * the account id: the exchange is the step that precedes a known uid, and a
 * per-run value would look like a new machine every time. The device id keeps
 * the 8-4-4-4-12 shape an official client reports.
 */

import { createHash } from "node:crypto";
import { asString, type QoderJson, qoderErrorDetail, qoderRequestSignal, readQoderJson } from "./client.ts";
import { type QoderFingerprint, qoderFingerprint } from "./cosy.ts";

/** The signing secret the `/algo` client hardcodes; the endpoint authenticates the client, not the account. */
const CLIENT_SECRET = "d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==";
/** Client identity on the exchange: the login path, not the agent path. */
const LOGIN_CLIENT_TYPE = "5";
const COSY_VERSION = "1.0.10";

/** Qoder's own base64 variant, byte-swapped and remapped for `/Encode=1` bodies. */
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STANDARD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** Padding in the custom alphabet, so the encoded string keeps the base64 length. */
const CUSTOM_PAD = "$";

/**
 * Encode a request body for the endpoints that ask `Encode=1`: standard base64
 * with its thirds rotated (last, middle, first) and its characters remapped onto
 * Qoder's alphabet, padding included.
 *
 * The order matters. A padded base64 string ends in characters that are part of
 * the rotation, so stripping the padding first rotates a different string and
 * every padded body comes out shifted. The real exchange body is 185 bytes, whose
 * base64 is padded, so dropping the `=` here produced a body the endpoint read as
 * a malformed payload and refused with 401.
 */
export function encodeQoderBody(plain: Uint8Array): string {
	const standard = Buffer.from(plain).toString("base64");
	const third = Math.floor(standard.length / 3);
	const rotated =
		standard.slice(standard.length - third) +
		standard.slice(third, standard.length - third) +
		standard.slice(0, third);
	let encoded = "";
	for (const char of rotated) {
		const index = STANDARD_ALPHABET.indexOf(char);
		encoded += index === -1 ? (char === "=" ? CUSTOM_PAD : char) : CUSTOM_ALPHABET[index];
	}
	return encoded;
}

/** Legitimate-request headers: an MD5 over the app code, the secret and an RFC 1123 date. */
function legacySignature(date: string): string {
	return createHash("md5").update(["cosy", CLIENT_SECRET, date].join("&")).digest("hex");
}

function httpDate(): string {
	return new Date().toUTCString();
}

/** Body of one exchange: a device token is redeemed as-is, a refresh token asks for a rotation. */
function exchangeBody(credential: string): string {
	const isRefreshToken = credential.startsWith("drt-");
	const inner = JSON.stringify({
		personalToken: isRefreshToken ? "" : credential,
		securityOauthToken: "",
		refreshToken: isRefreshToken ? credential : "",
		needRefresh: isRefreshToken,
		authInfo: {},
	});
	return encodeQoderBody(new TextEncoder().encode(JSON.stringify({ payload: inner, encodeVersion: "1" })));
}

function tokenField(body: QoderJson | null, ...keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = asString(body?.[key]);
		if (value) return value;
	}
	const data = body?.data;
	if (data && typeof data === "object" && !Array.isArray(data)) {
		for (const key of keys) {
			const value = asString((data as QoderJson)[key]);
			if (value) return value;
		}
	}
	return undefined;
}

export interface QoderRenewedToken {
	/** New `dt-...` access token. */
	token: string;
	/** New `drt-...` refresh token, or the one the exchange was started with. */
	refreshToken?: string;
}

/**
 * Trade a refresh token for a fresh device token. Falls back to the device
 * token when the credential recorded no refresh token: that path renews the
 * access token but cannot rotate the refresh token, so it only buys time.
 */
export async function renewQoderToken(values: {
	credential: string;
	jobTokenUrl: string;
	/** Device identity the exchange presents; derived from the credential when absent. */
	fingerprint?: QoderFingerprint;
	signal: AbortSignal;
}): Promise<QoderRenewedToken> {
	const date = httpDate();
	const fingerprint = values.fingerprint ?? qoderFingerprint(`cred:${values.credential}`);
	const response = await fetch(values.jobTokenUrl, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/json",
			"accept-encoding": "identity",
			"user-agent": "Go-http-client/2.0",
			appcode: "cosy",
			date,
			signature: legacySignature(date),
			"login-version": "v2",
			"cosy-clienttype": LOGIN_CLIENT_TYPE,
			"cosy-version": COSY_VERSION,
			"cosy-machineid": fingerprint.machineId,
			"cosy-machinetoken": fingerprint.machineToken,
			"cosy-machinetype": fingerprint.machineType,
		},
		body: exchangeBody(values.credential),
		signal: qoderRequestSignal(values.signal),
	});
	const body = await readQoderJson(response);
	if (!response.ok) {
		throw new Error(`Qoder token exchange failed (HTTP ${response.status})${qoderErrorDetail(body)}`);
	}
	const token = tokenField(body, "device_token", "deviceToken", "access_token", "accessToken", "token");
	if (!token) throw new Error("Qoder token exchange returned no device token");
	const refreshToken = tokenField(body, "refresh_token", "refreshToken");
	return {
		token,
		refreshToken: refreshToken ?? (values.credential.startsWith("drt-") ? values.credential : undefined),
	};
}
