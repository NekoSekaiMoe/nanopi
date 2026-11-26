/**
 * pi-token-usage — the display half of pi-token-cost-ledger, backed by
 * nanopi's own usage ledger. No second JSONL format and no prices.json: costs
 * come from the prices recorded on each response, so a historical figure is a
 * historical one.
 *
 * `/token-usage` prints totals by model and by period (today, week, month,
 * year, all). The current session is always included: the on-disk index
 * refreshes stale files only, so the last turn is read from the in-memory
 * session entries.
 */

import { dirname } from "node:path";
import type { ModuleApi, ModuleCommandContext } from "../../../core/modules/types.ts";
import { UsageLedgerIndex } from "../../../core/usage-ledger.ts";
import { addUsageToTotals, createUsageTotals, getUsageCostBreakdown, type UsageTotals, type UsageCostBreakdownEntry } from "../../../core/usage-totals.ts";

type Period = "today" | "week" | "month" | "year" | "all";
const PERIODS: readonly Period[] = ["today", "week", "month", "year", "all"];

function periodStart(period: Period, now: Date): number {
	const y = now.getFullYear();
	const m = now.getMonth();
	const d = now.getDate();
	switch (period) {
		case "today":
			return new Date(y, m, d).getTime();
		case "week": {
			const day = now.getDay();
			return new Date(y, m, d - (day === 0 ? 6 : day - 1)).getTime();
		}
		case "month":
			return new Date(y, m, 1).getTime();
		case "year":
			return new Date(y, 0, 1).getTime();
		case "all":
			return 0;
	}
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

function line(totals: UsageTotals): string {
	const tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	return `${fmtTokens(tokens)} tokens (in ${fmtTokens(totals.input)}, out ${fmtTokens(totals.output)}${
		totals.cacheRead > 0 ? `, cache read ${fmtTokens(totals.cacheRead)}` : ""
	}), $${totals.cost.toFixed(2)}`;
}

function sessionTotals(ctx: ModuleCommandContext, since: number): UsageTotals {
	const totals = createUsageTotals();
	let ts = Date.now();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			ts = typeof entry.message.timestamp === "number" ? entry.message.timestamp : ts;
			if (ts >= since) addUsageToTotals(totals, entry.message.usage);
		} else if (entry.type === "usage") {
			ts = typeof entry.timestamp === "number" ? entry.timestamp : ts;
			if (ts >= since) addUsageToTotals(totals, entry.usage);
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			ts = typeof entry.message.timestamp === "number" ? entry.message.timestamp : ts;
			if (ts >= since) addUsageToTotals(totals, entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			ts = typeof entry.timestamp === "number" ? entry.timestamp : ts;
			if (ts >= since) addUsageToTotals(totals, entry.usage);
		}
	}
	return totals;
}

export default function tokenUsage(pi: ModuleApi): void {
	pi.registerCommand("token-usage", {
		description:
			"Show token and cost totals by period and model. Usage: /token-usage [today|week|month|year|all] [model <name>].",
		getArgumentCompletions: (prefix) => PERIODS.filter((p) => p.startsWith(prefix.toLowerCase())).map((p) => ({ label: p, value: p })),
		handler: async (args: string, ctx: ModuleCommandContext) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const periodArg = parts.find((p) => (PERIODS as readonly string[]).includes(p));
			const period = (periodArg ?? "today") as Period;
			const modelIdx = parts.indexOf("model");
			const modelFilter = modelIdx >= 0 ? parts.slice(modelIdx + 1).join(" ") : "";
			const since = periodStart(period, new Date());

			const entries = ctx.sessionManager.getEntries();
			const current = getUsageCostBreakdown(entries);
			const lines: string[] = [];
			lines.push(`# Token usage (${period}${modelFilter ? `, model ~${modelFilter}` : ""})`);
			if (modelFilter) {
				const matches: UsageCostBreakdownEntry[] = current.filter((e: UsageCostBreakdownEntry) => e.key.toLowerCase().includes(modelFilter.toLowerCase()));
				lines.push(
					matches.length > 0
						? `current session: ${matches.map((e) => `${e.key}: ${fmtTokens(e.tokens)} / $${e.cost.toFixed(2)}`).join("; ")}`
						: "current session: no usage for that model",
				);
			} else if (current.length > 0) {
				lines.push("current session by model:");
				for (const e of current.slice(0, 12) as UsageCostBreakdownEntry[]) lines.push(`- ${e.key}: ${fmtTokens(e.tokens)} / $${e.cost.toFixed(2)}`);
			}

			// The rolling ledger reads the other session files. Its sessions live one
			// level below the directory of the active session file.
			const sessionFile = ctx.sessionManager.getSessionFile?.();
			if (sessionFile) {
				const sessionsDir = dirname(sessionFile);
				const index = new UsageLedgerIndex();
				await index.refresh(sessionsDir);
				const totals = index.totals();
				const all = totals.totals;
				const prompt = all.input + all.cacheRead + all.cacheWrite;
				lines.push(`all sessions (${totals.files}): ${line(all)}`);
				if (prompt > 0 && all.cacheRead > 0) {
					lines.push(`cache hit: ${((all.cacheRead / prompt) * 100).toFixed(1)}%`);
				}
				if (all.models > 0) lines.push(`models seen: ${all.models}`);
			}
			const now = sessionTotals(ctx, since);
			lines.push(`this session since ${period}: ${line(now)}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

export { periodStart, fmtTokens };
