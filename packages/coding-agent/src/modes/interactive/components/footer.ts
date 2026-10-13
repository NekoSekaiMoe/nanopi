import { isAbsolute, relative, resolve, sep } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@nanopi/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { ContextUsage } from "../../../core/modules/types.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	contextUsage: ContextUsage | undefined;
}

/** Resolve used context tokens: provider-reported usage first, else totals. */
export function resolveFooterUsedTokens(
	contextUsage: ContextUsage | undefined,
	usageTotals: UsageTotals,
	contextWindow: number,
): number | null {
	if (contextUsage?.tokens !== null && contextUsage?.tokens !== undefined) return contextUsage.tokens;
	if (contextUsage?.percent !== null && contextUsage?.percent !== undefined && contextWindow > 0) {
		return Math.round((contextUsage.percent / 100) * contextWindow);
	}
	const total = usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite;
	return total > 0 ? total : null;
}

/**
 * Codex-style single-line footer: `used xk/yk · / for more details`.
 * Computes token/context stats from session; extension statuses are intentionally
 * hidden so the bottom line stays exactly like the reference layout.
 */
export class FooterComponent implements Component {
	private session: AgentSession;
	private sessionStats?: SessionStats;
	/** Transient replacement for the footer line, e.g. the "press again to quit" reminder. */
	private transientLine: string | undefined;
	/** Shell mode: right-align a yellow "shell" label on the footer line (Codex-style). */
	private shellMode = false;

	constructor(session: AgentSession, _footerData: ReadonlyFooterDataProvider) {
		this.session = session;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	/** Show the shell-mode label on the right of the footer line. */
	setShellMode(active: boolean): void {
		this.shellMode = active;
	}

	/** Temporarily replace the footer line; pass undefined to restore it. */
	setTransientLine(line: string | undefined): void {
		this.transientLine = line;
	}

	setAutoCompactEnabled(_enabled: boolean): void {
		// No-op: the single-line footer has no auto-compact indicator. Kept for call-site compatibility.
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		this.sessionStats = {
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			usageTotals,
			contextUsage,
		};
		return this.sessionStats;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.transientLine !== undefined) {
			return [truncateToWidth(theme.fg("dim", this.transientLine), width, theme.fg("dim", "…"))];
		}
		const state = this.session.state;
		const { usageTotals, contextUsage } = this.getSessionStats();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const used = resolveFooterUsedTokens(contextUsage, usageTotals, contextWindow);
		const usedText = used === null ? "?" : formatTokens(used);
		const line = `used ${usedText}/${formatTokens(contextWindow)} · / for more details`;
		const dimLine = theme.fg("dim", line);
		if (!this.shellMode) return [truncateToWidth(dimLine, width, theme.fg("dim", "…"))];
		// Right-align the shell label; drop it when the usage line would not fit alongside.
		const label = theme.fg("bashMode", "shell");
		const budget = width - 1 - 5;
		if (budget <= 0) return [truncateToWidth(dimLine, width, theme.fg("dim", "…"))];
		const left = truncateToWidth(dimLine, budget, theme.fg("dim", "…"));
		return [left + " ".repeat(width - visibleWidth(left) - 5) + label];
	}
}
