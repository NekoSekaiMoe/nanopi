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

/** Headers a desktop Qoder client sends for check-in calls on the global site. */
export function qoderCheckinHeaders(deviceToken: string): Record<string, string> {
	return {
		authorization: `Bearer ${deviceToken}`,
		accept: "application/json",
		"accept-language": "zh-CN",
		"user-agent": "Qoder",
		"cosy-clienttype": "10",
	};
}
