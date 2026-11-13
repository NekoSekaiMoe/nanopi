/**
 * Qoder daily check-in (the campaign that pays out credits once per day).
 *
 * Two plain Bearer calls against the region's OpenAPI host:
 * `GET /sash/api/v1/me/campaigns` lists the account's campaigns and
 * `POST /sash/api/v1/me/campaigns/<id>/claim` claims one. The legacy
 * `daily-check-in/claim` endpoint is deliberately not used: it answers 409 on
 * unclaimed days and pays nothing, so trusting it reports a claim that never
 * happened. Only the campaign flow grants credits.
 *
 * Claiming is idempotent: a campaign already taken today answers
 * `replayed: true`, which reads as "already claimed" rather than an error.
 */

import {
	asNumber,
	asString,
	type QoderDeviceIdentity,
	type QoderJson,
	qoderCheckinHeaders,
	qoderErrorDetail,
	qoderRequestSignal,
	readQoderJson,
} from "./client.ts";
import type { QoderEndpoints } from "./endpoints.ts";

export type QoderCheckinStatus = "claimed" | "already_claimed" | "no_campaign" | "error";

export interface QoderCheckinResult {
	status: QoderCheckinStatus;
	/** Credits granted by this call; 0 when nothing was claimed. */
	amount: number;
	/** Campaign window the claim belongs to (`YYYY-MM-DD`), when the server reported one. */
	windowDate?: string;
	/** Human-readable outcome, including the server's error text on failure. */
	message: string;
	/** Whether the request carried a captured device identity. A missing one explains an empty list. */
	fingerprint: boolean;
	/** Name of the identity field the request carried, for a capture that is only half complete. */
	fingerprintFields?: string[];
	/** Campaigns the server listed, as `ACTION/STATUS`, in server order. */
	campaigns: string[];
	/** Trimmed campaign list response, for a run that found nothing claimable. */
	raw?: string;
}

/** What one account's check-in is signed with. */
export interface QoderCheckinOptions {
	/**
	 * Stored device identity. The global site withholds the campaign from a
	 * request that carries none, which is indistinguishable from "no campaign
	 * today" unless the answer says how many entries came back.
	 */
	device?: QoderDeviceIdentity;
	/**
	 * Window the caller finished (`YYYY-MM-DD`). A daily window rolls over at
	 * 10:00, so a session that starts before it claims the previous day's
	 * window; reporting that lets the caller say so instead of nothing.
	 */
	previousWindowDate?: string;
}

interface QoderCampaign {
	campaignId: string;
	campaignKey?: string;
	actionType?: string;
	claimStatus?: string;
	/** Window start, in Unix seconds. */
	startAt?: number;
	benefit?: { kind?: string; amount?: number };
}

const CAMPAIGN_ACTION = "CLAIM_BENEFIT";
/** How much of the campaign list response a diagnostic line keeps. */
const RAW_LIMIT = 400;

/** Identity fields a request actually carried, in header order. */
function fingerprintFields(device: QoderDeviceIdentity | undefined): string[] {
	if (!device) return [];
	const fields: string[] = [];
	if (device.machineToken) fields.push("machinetoken");
	if (device.machineType) fields.push("machinetype");
	if (device.machineId) fields.push("machineid");
	if (device.machineCode) fields.push("machinecode");
	return fields;
}

/** What a run found, for the caller to log: a `no_campaign` answer reads as "missing identity" or "nothing issued". */
function diagnostics(options: QoderCheckinOptions) {
	const fields = fingerprintFields(options.device);
	return { fingerprint: fields.length > 0, fingerprintFields: fields.length > 0 ? fields : undefined };
}

/** `ACTION/STATUS` per listed campaign: the pair says what the server issued instead of the daily entry. */
function campaignSummary(campaigns: readonly QoderCampaign[]): string[] {
	return campaigns.map((campaign) => `${campaign.actionType ?? "?"}/${campaign.claimStatus ?? "?"}`);
}

function rawBody(body: QoderJson | null): string | undefined {
	if (!body) return undefined;
	const text = JSON.stringify(body);
	return text.length > RAW_LIMIT ? `${text.slice(0, RAW_LIMIT)}...` : text;
}

function parseCampaigns(body: QoderJson | null): QoderCampaign[] {
	const raw = body?.campaigns;
	if (!Array.isArray(raw)) return [];
	const campaigns: QoderCampaign[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const record = entry as QoderJson;
		const campaignId = asString(record.campaignId);
		if (!campaignId) continue;
		const benefit = record.benefit && typeof record.benefit === "object" ? (record.benefit as QoderJson) : undefined;
		campaigns.push({
			campaignId,
			campaignKey: asString(record.campaignKey),
			actionType: asString(record.actionType),
			claimStatus: asString(record.claimStatus),
			startAt: asNumber(record.startAt),
			benefit: benefit ? { kind: asString(benefit.kind), amount: asNumber(benefit.amount) } : undefined,
		});
	}
	return campaigns;
}

/** Wall-clock date of a campaign window; daily windows roll over at 10:00 Beijing time. */
function windowDate(campaign: QoderCampaign | undefined): string | undefined {
	return campaign?.startAt ? new Date(campaign.startAt * 1000).toISOString().slice(0, 10) : undefined;
}

/**
 * This call claimed (or found claimed) a window the caller already finished.
 * That is what a startup check before 10:00 looks like: the daily window has
 * not rolled over yet, so the claim covers yesterday and today is still open.
 */
function previousWindowNote(result: QoderCheckinResult, options: QoderCheckinOptions): QoderCheckinResult {
	const previous = options.previousWindowDate;
	if (!previous || result.windowDate !== previous) return result;
	return {
		...result,
		message: `${result.message} (window ${result.windowDate}, which this machine already claimed; a new window opens at 10:00)`,
	};
}

async function claimCampaign(
	campaign: QoderCampaign,
	deviceToken: string,
	endpoints: QoderEndpoints,
	options: QoderCheckinOptions,
	signal: AbortSignal,
): Promise<QoderCheckinResult> {
	const host = endpoints.openApiHost;
	const response = await fetch(`https://${host}/sash/api/v1/me/campaigns/${campaign.campaignId}/claim`, {
		method: "POST",
		headers: { ...qoderCheckinHeaders(deviceToken, options.device), origin: `https://${host}` },
		signal: qoderRequestSignal(signal),
	});
	const body = await readQoderJson(response);
	const base = { ...diagnostics(options), campaigns: [`${campaign.actionType}/${campaign.claimStatus}`] };
	if (!response.ok) {
		return {
			...base,
			status: "error",
			amount: 0,
			windowDate: windowDate(campaign),
			message: `claim failed (HTTP ${response.status})${qoderErrorDetail(body)}`,
			raw: rawBody(body),
		};
	}
	if (asString(body?.status) !== "CLAIMED") {
		return {
			...base,
			status: "error",
			amount: 0,
			windowDate: windowDate(campaign),
			message: `unexpected claim status${qoderErrorDetail(body)}`,
			raw: rawBody(body),
		};
	}
	const benefit = body?.benefit && typeof body.benefit === "object" ? (body.benefit as QoderJson) : undefined;
	const amount = asNumber(benefit?.amount) ?? campaign.benefit?.amount ?? 0;
	if (body?.replayed === true) {
		return {
			...base,
			status: "already_claimed",
			amount,
			windowDate: windowDate(campaign),
			message: "already claimed today",
		};
	}
	return {
		...base,
		status: "claimed",
		amount,
		windowDate: windowDate(campaign),
		message: `claimed +${amount} credits`,
	};
}

/**
 * Claim one account's daily check-in. Server-side failures come back as an
 * `error` result instead of throwing, so a batch run reports every account.
 */
export async function checkinQoder(
	deviceToken: string,
	endpoints: QoderEndpoints,
	options: QoderCheckinOptions,
	signal: AbortSignal,
): Promise<QoderCheckinResult> {
	const token = deviceToken.trim();
	if (!token)
		return { status: "error", amount: 0, message: "no device token", campaigns: [], ...diagnostics(options) };

	const host = endpoints.openApiHost;
	const response = await fetch(`https://${host}/sash/api/v1/me/campaigns`, {
		method: "GET",
		headers: qoderCheckinHeaders(token, options.device),
		signal: qoderRequestSignal(signal),
	});
	const body = await readQoderJson(response);
	if (!response.ok) {
		return {
			...diagnostics(options),
			status: "error",
			amount: 0,
			message: `campaign lookup failed (HTTP ${response.status})${qoderErrorDetail(body)}`,
			campaigns: [],
			raw: rawBody(body),
		};
	}

	const campaigns = parseCampaigns(body);
	const base = { ...diagnostics(options), campaigns: campaignSummary(campaigns) };
	const claimable = campaigns.filter((campaign) => campaign.actionType === CAMPAIGN_ACTION);
	const target = claimable.find((campaign) => campaign.claimStatus === "CLAIMABLE");
	if (target) return previousWindowNote(await claimCampaign(target, token, endpoints, options, signal), options);

	const claimed = claimable.find((campaign) => campaign.claimStatus === "CLAIMED");
	if (claimed) {
		return previousWindowNote(
			{
				...base,
				status: "already_claimed",
				amount: claimed.benefit?.amount ?? 0,
				windowDate: windowDate(claimed),
				message: "already claimed today",
			},
			options,
		);
	}
	// The raw count separates "no campaign is running" from "campaigns exist but
	// none was issued to this request": the global site withholds the entry from
	// a device identity it does not recognize, and an empty list is the only
	// thing a caller can act on. Which identity fields the request carried, and
	// what the server listed instead, are what tells the two apart afterwards.
	const count =
		campaigns.length === 0 ? "the server listed no campaign" : `${campaigns.length} campaign(s), none claimable`;
	return {
		...base,
		status: "no_campaign",
		amount: 0,
		message: `no claimable campaign (${count})`,
		raw: rawBody(body),
	};
}
