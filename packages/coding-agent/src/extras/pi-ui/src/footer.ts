/**
 * Codex-style single line below the editor: `used xk/yk · / for more details`,
 * with right-aligned extension statuses (`ctx.ui.setStatus()` channel) and a
 * yellow `shell` label while the composer is in shell mode. The right side
 * wins over the left: the usage line truncates when both cannot fit.
 */

import type { ModuleContext, ReadonlyFooterDataProvider, Theme } from "@nanopi/pi-coding-agent";
import type { Component, TUI } from "@nanopi/pi-tui";
import { truncateToWidth, visibleWidth } from "@nanopi/pi-tui";
import { captureRenderTrigger } from "./thinking.ts";

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function resolveUsedTokens(ctx: ModuleContext): number | null {
	const usage = ctx.getContextUsage();
	if (usage?.tokens !== null && usage?.tokens !== undefined) return usage.tokens;
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (usage?.percent !== null && usage?.percent !== undefined && contextWindow > 0) {
		return Math.round((usage.percent / 100) * contextWindow);
	}
	return null;
}

/** Shell mode mirrors `isBashMode` in interactive-mode: composer text (after
 * leading whitespace) starts with `!`. Polled per render; editor input always
 * triggers a repaint, so the label tracks typing without new plumbing. */
export function isShellMode(ctx: Pick<ModuleContext, "ui">): boolean {
	return ctx.ui.getEditorText().trimStart().startsWith("!");
}

/** Right-aligned suffix: extension status values (producers embed their own
 * ANSI colors via `ctx.ui.theme.fg()`) plus the yellow shell label. */
export function renderStatusSuffix(
	footerData: ReadonlyFooterDataProvider,
	theme: Theme,
	shellMode: boolean,
): string {
	const parts: string[] = [];
	for (const status of footerData.getExtensionStatuses().values()) {
		if (status) parts.push(status);
	}
	if (shellMode) parts.push(theme.fg("bashMode", "shell"));
	return parts.join(" ");
}

export function renderToolbarLine(
	ctx: ModuleContext,
	theme: Theme,
	footerData: ReadonlyFooterDataProvider,
	width: number,
): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const used = resolveUsedTokens(ctx);
	const line = `used ${used === null ? "?" : formatTokens(used)}/${formatTokens(contextWindow)} · / for more details`;
	const dimLine = theme.fg("dim", line);
	const suffix = renderStatusSuffix(footerData, theme, isShellMode(ctx));
	if (suffix === "") {
		return truncateToWidth(dimLine, Math.max(0, width), theme.fg("dim", "…"));
	}
	const suffixWidth = visibleWidth(suffix);
	const budget = width - 1 - suffixWidth;
	if (budget <= 0) {
		return truncateToWidth(dimLine, Math.max(0, width), theme.fg("dim", "…"));
	}
	const left = truncateToWidth(dimLine, budget, theme.fg("dim", "…"));
	return left + " ".repeat(width - visibleWidth(left) - suffixWidth) + suffix;
}

export function installFooter(ctx: ModuleContext): void {
	ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider): Component & { dispose?(): void } => {
		// Hand the TUI to thinking.ts so landed summaries can repaint at once;
		// the footer factory is the one place pi-ui still receives it.
		captureRenderTrigger(tui);
		return {
			invalidate() {},
			render(width: number): string[] {
				return width > 0 ? [renderToolbarLine(ctx, theme, footerData, width)] : [];
			},
		};
	});
}
