/**
 * Qoder request helpers shared by the OAuth flow and the daily check-in.
 *
 * The device-token poll and the check-in endpoints are plain Bearer calls: no
 * request signing is involved, only the headers a desktop Qoder client sends.
 * Signing starts at inference requests, which this provider does not cover (the
 * models point at the OpenAI-compatible gateway instead).
 */

import { getProviderEnvValue } from "../utils/provider-env.ts";
import type { QoderRegion } from "./endpoints.ts";

const REQUEST_TIMEOUT_MS = 30 * 1000;

export type QoderJson = Record<string, unknown>;

export function qoderRequestSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]);
}

export async function readQoderJson(response: Response): Promise<QoderJson | null> {
	try {
		const json = await response.json();
		return json && typeof json === "object" && !Array.isArray(json) ? (json as QoderJson) : null;
	} catch {
		return null;
	}
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Message text a Qoder error body carries, prefixed with a colon for direct interpolation. */
export function qoderErrorDetail(body: QoderJson | null): string {
	for (const key of ["message", "msg", "error_description", "error", "code"]) {
		const value = body?.[key];
		if (typeof value === "string" && value.trim()) return `: ${value.trim()}`;
		if (typeof value === "number") return `: code ${value}`;
	}
	return "";
}

function parseRegion(value: string | undefined): QoderRegion | undefined {
	const normalized = value?.trim().toLowerCase();
	return normalized === "cn" || normalized === "global" ? normalized : undefined;
}

/**
 * Region of a login: the explicit argument wins (the provider id decides it),
 * then `QODER_REGION`, then the international site.
 */
export function resolveQoderRegion(explicit?: QoderRegion): QoderRegion {
	return explicit ?? parseRegion(getProviderEnvValue("QODER_REGION")) ?? "global";
}

/**
 * Device identity a check-in request may carry. The global site hands out its
 * campaign only to a request that looks like a real installation: a missing
 * `cosy-machinetoken` / `cosy-machinetype` reads as `no_campaign` for an account
 * that has never claimed in the official client. Every value here is captured
 * from an official client (a self-invented fingerprint is worse than none) and
 * travels on the credential, or on `QODER_MACHINE_*` env vars.
 *
 * The captures differ in how much they recorded, so the optional fields stay
 * optional: a request only claims the headers the capture actually holds.
 */
export interface QoderDeviceIdentity {
	machineToken?: string;
	machineType?: string;
	machineId?: string;
	machineCode?: string;
	/** Client version the capture came from; the desktop client reports `0.4.x`. */
	version?: string;
	/** Desktop client id; the default `10` is what the campaign flow sends without a capture. */
	clientType?: string;
	hostname?: string;
	machineOs?: string;
}

/**
 * Headers a desktop Qoder client sends for check-in calls. Device headers are
 * only added when the caller has a real identity to send: the CN site rejects
 * an invented fingerprint, so a CN call never carries one.
 */
export function qoderCheckinHeaders(deviceToken: string, device?: QoderDeviceIdentity): Record<string, string> {
	const headers: Record<string, string> = {
		authorization: `Bearer ${deviceToken}`,
		accept: "application/json",
		"accept-language": "zh-CN",
		"user-agent": "Qoder",
		"cosy-clienttype": device?.machineToken ? (device.clientType ?? "10") : "10",
	};
	if (!device?.machineToken) return headers;
	headers["cosy-version"] = device.version ?? "0.4.4";
	headers["cosy-machinetoken"] = device.machineToken;
	if (device.machineType) headers["cosy-machinetype"] = device.machineType;
	if (device.machineId) headers["cosy-machineid"] = device.machineId;
	if (device.machineCode) headers["cosy-machinecode"] = device.machineCode;
	headers["cosy-machinehostname"] = device.hostname ?? "localhost";
	headers["cosy-machineos"] = device.machineOs ?? "aarch64_darwin";
	return headers;
}
