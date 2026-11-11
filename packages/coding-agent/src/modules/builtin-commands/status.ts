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

import { join } from "node:path";
import { BUILD_VERSION } from "../../core/build-version.ts";
import { formatMiB, type MemorySample, sampleMemory } from "../../core/memory-usage.ts";
import type { ModuleApi, ModuleCommandContext, ToolInfo } from "../../core/modules/types.ts";
import { formatContextPath, getCompactExtensionLabels, type ResourceItem } from "../../core/resource-listing.ts";
import { type UsageLedger, UsageLedgerIndex } from "../../core/usage-ledger.ts";
import { formatTokens } from "./context.ts";
import { type StatusDialogHandle, type StatusRow, type StatusSection, showStatusDialog } from "./status-dialog.ts";

function formatCwd(cwd: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (home && (cwd === home || cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`))) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}
type TokenTotals = { input: number; output: number };

function collectTokenTotals(ctx: ModuleCommandContext): TokenTotals {
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

/**
 * Usage totals row: the rolling total over every session file, not just this
 * one, because "what did this month cost" is a question `/session` cannot
 * answer. Cost is the sum of the per-response prices recorded at write time,
 * so it is a historical figure, not a quote at today's catalog price.
 *
 * `pending` is set while a background pass is still walking the files, so the
 * row never presents a partial sum as the total.
 */
export function formatUsageLedgerRow(ledger: UsageLedger | undefined, pending = false): string {
	if (!ledger) return "indexing...";
	if (ledger.files === 0) return pending ? "indexing..." : "no sessions yet";

	const { totals } = ledger;
	const tokens = totals.input + totals.output;
	const sessions = ledger.files === 1 ? "1 session" : `${ledger.files} sessions`;
	const responses = totals.responses === 1 ? "1 response" : `${totals.responses} responses`;

	let text = `${formatTokens(tokens)} tokens, $${totals.cost.toFixed(2)} over ${sessions} (${responses})`;
	const promptTokens = totals.input + totals.cacheRead + totals.cacheWrite;
	if (promptTokens > 0 && (totals.cacheRead > 0 || totals.cacheWrite > 0)) {
		text += `, cache hit ${((totals.cacheRead / promptTokens) * 100).toFixed(1)}%`;
	} else if (totals.responses > 0) {
		// No provider reported cache activity. That is "unknown", not "always missed".
		text += ", cache not reported";
	}
	return pending ? `${text} (indexing...)` : text;
}

/** Ledger of the running process, keyed by the sessions directory it was built from. */
let cachedLedger: { dir: string; ledger: UsageLedger | undefined; pass: Promise<void>; listening: boolean } | undefined;

/**
 * Start (or reuse) the index over `<sessionsDir>`. The walk runs on the event
 * loop, so a dialog that opened mid-pass is redrawn when the totals land, and
 * every later pass re-parses only the files whose size or mtime moved. Call
 * `getUsageLedger()` to wait for it.
 */
export function startUsageLedger(dir: string): void {
	const running = cachedLedger?.dir === dir ? cachedLedger : undefined;
	if (running) {
		// A registered redraw only fires for the pass it was registered for: a
		// dialog that opens on an idle index must register for the refresh kicked
		// off by the next `/status`, not for the pass that already finished.
		if (running.ledger !== undefined) running.listening = false;
		return;
	}

	const state = { dir, ledger: undefined as UsageLedger | undefined } as {
		dir: string;
		ledger: UsageLedger | undefined;
		pass: Promise<void>;
		listening: boolean;
	};
	const index = new UsageLedgerIndex();
	state.pass = index
		.refresh(dir)
		.catch(() => {
			// An unreadable sessions tree leaves the partial totals; the next `/status` retries.
			if (cachedLedger === state) cachedLedger = undefined;
		})
		.then(() => {
			state.ledger = index.totals();
			if (cachedLedger === state && state.listening) notifyUsageLedger();
		});
	cachedLedger = state;
}

/** Totals a `/status` prints. Waits for the pass: a one-shot render has no later redraw to fall back on. */
export async function getUsageLedger(dir: string): Promise<UsageLedger | undefined> {
	startUsageLedger(dir);
	await cachedLedger?.pass;
	return cachedLedger?.dir === dir ? cachedLedger.ledger : undefined;
}

const ledgerListeners = new Set<() => void>();

/**
 * Register a redraw callback for the next completed pass. The TUI registers one
 * after drawing the dialog, which is how the "indexing..." row turns into real
 * numbers without the user reopening `/status`.
 */
export function startUsageLedgerRefresh(onUpdate: () => void): void {
	ledgerListeners.add(onUpdate);
	if (cachedLedger) cachedLedger.listening = true;
}

/** Run the registered redraw callbacks once; a dialog registers one per opening, so they do not accumulate. */
function notifyUsageLedger(): void {
	for (const listener of ledgerListeners) {
		ledgerListeners.delete(listener);
		listener();
	}
}

/**
 * Memory row: `rss 141MiB, peak 148MiB, heap 44MiB`. `sample` lets callers pass
 * the interactive session's last periodic sample; without one the row is
 * measured on demand.
 */
export function formatMemoryRow(sample?: MemorySample): string {
	const current = sample ?? sampleMemory();
	const text = `rss ${formatMiB(current.rss)}, peak ${formatMiB(current.rssPeak)}, heap ${formatMiB(current.heapUsed)}`;
	const external = current.external > 0 ? `, external ${formatMiB(current.external)}` : "";
	return text + external;
}

export function collectStatusRows(
	ctx: ModuleCommandContext,
	_allTools: ToolInfo[],
	usageLedger?: UsageLedger,
): StatusRow[] {
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
		{ label: "Usage totals:", value: formatUsageLedgerRow(usageLedger) },
		{ label: "Memory:", value: formatMemoryRow(ctx.getMemorySample?.()) },
	];
}

/**
 * Loaded-resource sections moved from the startup page: compact names, sorted
 * like the old collapsed startup lists (context files keep load order).
 */
export function collectStatusSections(ctx: ModuleCommandContext): StatusSection[] {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
	const resources = ctx.getLoadedResources();
	const sections: StatusSection[] = [];

	if (resources.contextFiles.length > 0) {
		sections.push({
			title: "Context",
			items: resources.contextFiles.map((file) => formatContextPath(file.path, ctx.cwd, home)),
		});
	}
	if (resources.skills.length > 0) {
		sections.push({
			title: "Skills",
			items: resources.skills.map((skill) => skill.name).sort((a, b) => a.localeCompare(b)),
		});
	}
	if (resources.prompts.length > 0) {
		sections.push({
			title: "Prompts",
			items: resources.prompts.map((prompt) => `/${prompt.name}`).sort((a, b) => a.localeCompare(b)),
		});
	}
	if (resources.extensions.length > 0) {
		const extensions: ResourceItem[] = resources.extensions.map((extension) => ({
			path: extension.path,
			sourceInfo: extension.sourceInfo,
		}));
		sections.push({
			title: "Extensions",
			items: [...getCompactExtensionLabels(extensions, home)].sort((a, b) => a.localeCompare(b)),
		});
	}
	return sections;
}

export function registerStatus(pi: ModuleApi) {
	pi.registerCommand("status", {
		description: "Show the current model, session, usage, and loaded resources",
		handler: async (_args, ctx) => {
			// The index outlives the dialog: the first opening shows partial totals and every
			// one after it re-reads only the files whose size or mtime moved.
			const dir = join(ctx.getAgentDir(), "sessions");
			const rows = collectStatusRows(ctx, pi.getAllTools(), await getUsageLedger(dir));
			const sections = collectStatusSections(ctx);
			const title = `π nanopi (${BUILD_VERSION})`;
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				const sectionLines = sections
					.filter((section) => section.items.length > 0)
					.map((section) => `[${section.title}]\n  ${section.items.join(", ")}`);
				ctx.ui.notify(
					[title, ...rows.map((row) => `${row.label} ${row.value}`), ...sectionLines].join("\n"),
					"info",
				);
				return;
			}
			let dialog: StatusDialogHandle | undefined;
			startUsageLedgerRefresh(() => {
				const current = cachedLedger?.dir === dir ? cachedLedger.ledger : undefined;
				dialog?.refresh(collectStatusRows(ctx, pi.getAllTools(), current));
			});
			dialog = await showStatusDialog(ctx, { title, rows, sections });
		},
	});
}
