/**
 * COSY request signing, the envelope Qoder's `/algo` endpoints demand.
 *
 * Every `/algo` call carries three things: a `cosy-key` (an RSA-encrypted
 * one-shot AES key), an identity payload encrypted with that key, and an MD5
 * signature over payload + key + date + body + path. The bearer token is
 * `Bearer COSY.<payload>.<signature>`. The signing key is the client's own
 * hardcoded public key, so this is client code, not a secret exchange.
 *
 * Device headers come from a fingerprint derived from the account id: the
 * international site accepts the derived one, and it keeps a given account
 * presenting the same virtual device across restarts.
 */

import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomUUID } from "node:crypto";

/** cosy protocol version reported when there is no captured client fingerprint. */
const COSY_VERSION = "1.0.10";
const COSY_CLIENT_TYPE = "5";
const COSY_USER_AGENT = "Go-http-client/2.0";

const SERVER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/** Identity the signature payload vouches for. */
export interface QoderIdentity {
	uid: string;
	name?: string;
	organizationId?: string;
	organizationName?: string;
	userType?: string;
	token: string;
	refreshToken?: string;
}

/** Device headers one account presents to the signed endpoints. */
export interface QoderFingerprint {
	machineId: string;
	machineToken: string;
	machineType: string;
}

function md5Hex(value: string): string {
	return createHash("md5").update(value).digest("hex");
}

function aesCbcEncrypt(plain: Buffer, key: Buffer): Buffer {
	const cipher = createCipheriv("aes-128-cbc", key, key.subarray(0, 16));
	return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** 32 hex digits shaped as UUIDv4: version digit `4`, variant hex digit `a`. */
function uuidShape(hex: string): string {
	const chars = hex.toLowerCase().split("");
	chars[12] = "4";
	chars[16] = "a";
	return [chars.slice(0, 8), chars.slice(8, 12), chars.slice(12, 16), chars.slice(16, 20), chars.slice(20)]
		.map((part) => part.join(""))
		.join("-");
}

/**
 * Stable device identity for an account. Derived rather than captured: the
 * upstream ties a device to an account, and a value that changed per run would
 * look like a new machine on every request.
 *
 * `machineId` keeps the 8-4-4-4-12 shape an official client reports. A bare
 * 32-hex id still signs a request, but anything that compares device ids
 * structurally (the job-token exchange included) reads it as a different kind
 * of client.
 */
export function qoderFingerprint(seed: string): QoderFingerprint {
	return {
		machineId: uuidShape(md5Hex(`machine:${seed}`)),
		machineToken: createHash("sha512").update(`machinetoken:${seed}`).digest("base64url").slice(0, 43),
		machineType: md5Hex(`machinetype:${seed}`).slice(0, 18),
	};
}

function payloadBase64(encryptedInfo: string): string {
	return Buffer.from(
		JSON.stringify({
			cosyVersion: COSY_VERSION,
			ideVersion: "",
			info: encryptedInfo,
			requestId: randomUUID(),
			version: "v1",
		}),
	).toString("base64");
}

/**
 * Headers for one signed request. `path` is the request path minus the `/algo`
 * prefix, and `body` is the exact request body string (empty for GET).
 */
export function qoderSignedHeaders(values: {
	identity: QoderIdentity;
	fingerprint: QoderFingerprint;
	path: string;
	body: string;
}): Record<string, string> {
	const tempKey = Buffer.from(randomUUID().replace(/-/g, "").slice(0, 16), "utf8");
	const cosyKey = publicEncrypt(
		{ key: createPublicKey(SERVER_PUBLIC_KEY), padding: constants.RSA_PKCS1_PADDING },
		tempKey,
	).toString("base64");
	const info = aesCbcEncrypt(
		Buffer.from(
			JSON.stringify({
				name: values.identity.name ?? "",
				aid: values.identity.uid,
				uid: values.identity.uid,
				yx_uid: "",
				organization_id: values.identity.organizationId ?? "",
				organization_name: values.identity.organizationName ?? "",
				user_type: values.identity.userType ?? "personal_standard",
				security_oauth_token: values.identity.token,
				refresh_token: values.identity.refreshToken ?? "",
			}),
			"utf8",
		),
		tempKey,
	).toString("base64");

	const date = Math.floor(Date.now() / 1000).toString();
	const payload = payloadBase64(info);
	const signature = md5Hex([payload, cosyKey, date, values.body, values.path].join("\n"));

	return {
		...qoderDeviceHeaders(values.fingerprint),
		"cosy-date": date,
		"cosy-user": values.identity.uid,
		"cosy-key": cosyKey,
		authorization: `Bearer COSY.${payload}.${signature}`,
	};
}

/** Device headers the signed endpoints require alongside the COSY bearer. */
export function qoderDeviceHeaders(fingerprint: QoderFingerprint): Record<string, string> {
	return {
		accept: "application/json",
		"content-type": "application/json",
		"cache-control": "no-cache",
		"user-agent": COSY_USER_AGENT,
		"login-version": "v2",
		"cosy-clienttype": COSY_CLIENT_TYPE,
		"cosy-version": COSY_VERSION,
		"cosy-data-policy": "agree",
		"cosy-scene": "assistant",
		"cosy-business-product": "ide",
		"cosy-business-type": "agent",
		"cosy-machineid": fingerprint.machineId,
		"cosy-machinetoken": fingerprint.machineToken,
		"cosy-machinetype": fingerprint.machineType,
	};
}

/** Request path without the `/algo` prefix, which is what the signature covers. */
export function qoderSigningPath(url: string): string {
	const path = new URL(url).pathname;
	return path.startsWith("/algo") ? path.slice("/algo".length) : path;
}
