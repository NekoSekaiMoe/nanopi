/**
 * Built-in `/status` command: Codex-style session status dialog.
 *
 * Rows are mapped to nanopi concepts (no Codex-only Visit/Approval/Sandbox/
 * Account/Limits rows):
 *
 *   Model / Model provider / Directory / Session / Thinking / Token usage /
 *   Context
 *
 * Dialog chrome and exit behavior match `/context` (bottom-docked overlay,
 * accent rules, Esc to close). Outside TUI mode a plain text summary is
 * emitted via `ctx.ui.notify`.
 */

import type { ExtensionAPI, ExtensionCommandContext, ToolInfo } from "@nanopi/pi-coding-agent";
import { VERSION } from "../../config.ts";
import { formatTokens } from "./context.ts";
import { type StatusRow, showStatusDialog } from "./status-dialog.ts";

function formatCwd(cwd: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (home && (cwd === home || cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`))) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

type TokenTotals = { input: number; output: number };

function collectTokenTotals(ctx: ExtensionCommandContext): TokenTotals {
	const totals: TokenTotals = { input: 0, output: 0 };
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "usage") {
			totals.input += entry.usage.input;
			totals.output += entry.usage.output;
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			totals.input += entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
			totals.output += entry.message.usage.output;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			totals.input += entry.message.usage.input;
			totals.output += entry.message.usage.output;
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			totals.input += entry.usage.input;
			totals.output += entry.usage.output;
		}
	}
	return totals;
}

export function collectStatusRows(ctx: ExtensionCommandContext, _allTools: ToolInfo[]): StatusRow[] {
	const model = ctx.model;
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? model?.contextWindow ?? 0;
	const totals = collectTokenTotals(ctx);
	const sessionName = ctx.sessionManager.getSessionName();
	const session = sessionName ?? ctx.sessionManager.getSessionId();
	const thinking = model?.reasoning ? (ctx.thinkingLevel ?? "off") : "n/a";

	let contextText = `n/a / ${formatTokens(contextWindow)}`;
	if (usage?.tokens !== null && usage?.tokens !== undefined) {
		contextText = `${formatTokens(usage.tokens)} / ${formatTokens(contextWindow)}`;
	} else if (usage?.percent !== null && usage?.percent !== undefined && contextWindow > 0) {
		const used = Math.round((usage.percent / 100) * contextWindow);
		contextText = `${formatTokens(used)} / ${formatTokens(contextWindow)} (${usage.percent.toFixed(1)}%)`;
	} else if (usage?.percent !== null && usage?.percent !== undefined) {
		contextText = `${usage.percent.toFixed(1)}%`;
	}
	if (
		usage?.percent !== null &&
		usage?.percent !== undefined &&
		contextText !== `n/a / ${formatTokens(contextWindow)}`
	) {
		if (!contextText.includes("%") && contextWindow > 0) {
			contextText += ` (${usage.percent.toFixed(1)}%)`;
		}
	}

	return [
		{ label: "Model:", value: model?.id ?? "no-model" },
		{ label: "Model provider:", value: model?.provider ?? "n/a" },
		{ label: "Directory:", value: formatCwd(ctx.cwd) },
		{ label: "Session:", value: session },
		{ label: "Thinking:", value: thinking },
		{
			label: "Token usage:",
			value: `${formatTokens(totals.input + totals.output)} total (${formatTokens(totals.input)} input + ${formatTokens(totals.output)} output)`,
		},
		{ label: "Context:", value: contextText },
	];
}

export function registerStatus(pi: ExtensionAPI) {
	pi.registerCommand("status", {
		description: "Show the current model, session, and usage",
		handler: async (_args, ctx) => {
			const rows = collectStatusRows(ctx, pi.getAllTools());
			const title = `π nanopi (v${VERSION})`;
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify([title, ...rows.map((row) => `${row.label} ${row.value}`)].join("\n"), "info");
				return;
			}
			await showStatusDialog(ctx, { title, rows });
		},
	});
}
