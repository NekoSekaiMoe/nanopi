/**
 * Daily Qoder check-in, run once per session start.
 *
 * Qoder pays a daily credit reward through a campaign that has to be claimed
 * by hand in the web console; claiming is idempotent, so the only thing worth
 * automating is remembering to do it. This module claims for every logged-in
 * Qoder account (both sites) when a session starts, and stays out of the way
 * when there is nothing to claim.
 *
 * Failures are reported as a single dim status line: a check-in that did not
 * happen must not interrupt a session or read as an error the user has to fix.
 */

import type { ModelRegistry } from "../../core/model-registry.ts";
import type { ModuleApi } from "../../core/modules/types.ts";
import { QODER_CHECKIN_ENV } from "./constants.ts";
import { type QoderCheckinSummary, runQoderCheckin } from "./run.ts";

/** Coalesce concurrent session starts (reload, fork) into one check-in. */
let inFlight: Promise<QoderCheckinSummary[]> | undefined;

function checkinDisabled(): boolean {
	const value = process.env[QODER_CHECKIN_ENV]?.trim().toLowerCase();
	return value === "0" || value === "false" || value === "off";
}

async function checkinOnce(modelRegistry: ModelRegistry): Promise<QoderCheckinSummary[]> {
	inFlight ??= runQoderCheckin(modelRegistry, AbortSignal.timeout(60_000)).finally(() => {
		inFlight = undefined;
	});
	return inFlight;
}

/**
 * What a `no_campaign` answer needs to be actionable: whether the request
 * carried a captured identity, and which campaigns the server listed instead.
 * Without it the message cannot tell "nothing was issued" from "the site did not
 * recognize this installation", and both read as a claim that did not happen.
 */
function noCampaignDetail(summary: QoderCheckinSummary): string {
	const identity = summary.fingerprint
		? `device identity: ${summary.fingerprintFields?.join(", ") ?? "sent"}`
		: "no device identity";
	const listed = summary.campaigns?.length ? summary.campaigns.join(", ") : "nothing";
	return `${summary.message}; ${identity}; listed: ${listed}`;
}

export function collectCheckinMessage(summaries: readonly QoderCheckinSummary[]): string | undefined {
	const withResult = summaries.filter((summary) => summary.status !== "none");
	if (withResult.length === 0) return undefined;
	return withResult
		.map((summary) => {
			const name = summary.account ? `${summary.provider} (${summary.account})` : summary.provider;
			if (summary.status === "unconfigured") return `${name}: missing OAuth login, run /login ${summary.provider}`;
			if (summary.status === "error") return `${name}: check-in failed, ${summary.message}`;
			if (summary.status === "no_campaign") return `${name}: ${noCampaignDetail(summary)}`;
			return `${name}: ${summary.message}`;
		})
		.join(" · ");
}

export default function qoderCheckinExtension(pi: ModuleApi): void {
	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup") return;
		if (checkinDisabled()) return;
		const summaries = await checkinOnce(ctx.modelRegistry);
		const message = collectCheckinMessage(summaries);
		if (message) ctx.ui.notify(`Qoder daily check-in · ${message}`);
	});

	pi.registerCommand("qoder-checkin", {
		description: "Claim today's Qoder daily credits for every logged-in account",
		handler: async (_args, ctx) => {
			const summaries = await runQoderCheckin(ctx.modelRegistry, AbortSignal.timeout(60_000));
			const configured = summaries.filter((summary) => summary.status !== "none");
			if (configured.length === 0) {
				ctx.ui.notify("No Qoder account is logged in. Run /login qoder or /login qoder-cn.", "warning");
				return;
			}
			const message = collectCheckinMessage(summaries) ?? "nothing to report";
			const failed = configured.some((summary) => summary.status === "error");
			ctx.ui.notify(`Qoder daily check-in · ${message}`, failed ? "warning" : "info");
		},
	});
}
