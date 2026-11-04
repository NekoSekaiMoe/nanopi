/**
 * One COSY-signed request scope: the wrapped AES key, the encrypted identity
 * payload and the device headers that stay put across the requests of one
 * conversation.
 *
 * Qoder's `/algo` endpoints demand three things: a `cosy-key` (an RSA-encrypted
 * one-shot AES key), an identity payload encrypted with that key, and an MD5
 * signature over payload + key + date + body + path. `qoderSignedHeaders()`
 * rebuilds all three per request, which is right for a one-shot catalogue
 * fetch. Signing every message of a conversation that way would hand the same
 * device a new key and a new device identity each turn; a scope keeps them, so
 * a conversation looks like one client session.
 */

import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomUUID } from "node:crypto";
import { type QoderFingerprint, type QoderIdentity, qoderDeviceHeaders, qoderSigningPath } from "./cosy.ts";

const SERVER_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/** `cosyVersion` reported inside the payload. */
const PAYLOAD_COSY_VERSION = "1.0.10";

function md5Hex(value: string): string {
	return createHash("md5").update(value).digest("hex");
}

/** Key material one account presents to a run of signed requests. */
export interface QoderCosySession {
	identity: QoderIdentity;
	fingerprint: QoderFingerprint;
	/** RSA-wrapped AES key, base64; sent as `cosy-key`. */
	cosyKey: string;
	/** AES-encrypted identity payload, base64; embedded in the bearer. */
	info: string;
}

function aesCbcEncrypt(plain: Buffer, key: Buffer): Buffer {
	const cipher = createCipheriv("aes-128-cbc", key, key.subarray(0, 16));
	return Buffer.concat([cipher.update(plain), cipher.final()]);
}

/** A fresh AES key wrapped for the server, and the identity sealed with it. */
export function createQoderCosySession(identity: QoderIdentity, fingerprint: QoderFingerprint): QoderCosySession {
	const tempKey = Buffer.from(randomUUID().replace(/-/g, "").slice(0, 16), "utf8");
	const cosyKey = publicEncrypt(
		{ key: createPublicKey(SERVER_PUBLIC_KEY), padding: constants.RSA_PKCS1_PADDING },
		tempKey,
	).toString("base64");
	const info = aesCbcEncrypt(
		Buffer.from(
			JSON.stringify({
				name: identity.name ?? "",
				aid: identity.uid,
				uid: identity.uid,
				yx_uid: "",
				organization_id: identity.organizationId ?? "",
				organization_name: identity.organizationName ?? "",
				user_type: identity.userType ?? "personal_standard",
				security_oauth_token: identity.token,
				refresh_token: identity.refreshToken ?? "",
			}),
			"utf8",
		),
		tempKey,
	).toString("base64");
	return { identity, fingerprint, cosyKey, info };
}

/** Headers for one request of the session; `body` is the exact request body the call sends. */
export function qoderSessionHeaders(
	session: QoderCosySession,
	request: { url: string; body: string },
): Record<string, string> {
	const date = Math.floor(Date.now() / 1000).toString();
	const payload = Buffer.from(
		JSON.stringify({
			cosyVersion: PAYLOAD_COSY_VERSION,
			ideVersion: "",
			info: session.info,
			requestId: randomUUID(),
			version: "v1",
		}),
	).toString("base64");
	const signature = md5Hex([payload, session.cosyKey, date, request.body, qoderSigningPath(request.url)].join("\n"));
	return {
		...qoderDeviceHeaders(session.fingerprint),
		"cosy-date": date,
		"cosy-user": session.identity.uid,
		"cosy-key": session.cosyKey,
		authorization: `Bearer COSY.${payload}.${signature}`,
	};
}
