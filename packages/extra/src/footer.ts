/**
 * Footer badges: replaces the built-in single-line footer with the same usage
 * line plus right-aligned mode badges — red `yolo`, green `plan`, both can
 * show at once. Same approach as the pi-ui extra: the one usage line is
 * reimplemented (the extension footer API replaces, not decorates).
 */

import { truncateToWidth, visibleWidth } from "@nanopi/pi-tui";
import type { ModeEngine } from "./mode-engine.ts";

/** Structural slices of the extension context and theme the footer needs. */
export interface FooterContextSlice {
	getContextUsage(): { tokens: number | null; percent: number | null; contextWindow: number } | undefined;
	readonly model?: { contextWindow?: number } | undefined;
}

export interface FooterThemeSlice {
	fg(color: "dim" | "error" | "success", text: string): string;
}

export interface FooterTuiSlice {
	requestRender(): void;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function resolveUsedTokens(ctx: FooterContextSlice): number | null {
	const usage = ctx.getContextUsage();
	if (usage?.tokens !== null && usage?.tokens !== undefined) return usage.tokens;
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	if (usage?.percent !== null && usage?.percent !== undefined && contextWindow > 0) {
		return Math.round((usage.percent / 100) * contextWindow);
	}
	return null;
}

export function renderFooterLine(ctx: FooterContextSlice, theme: FooterThemeSlice, width: number): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const used = resolveUsedTokens(ctx);
	const line = `used ${used === null ? "?" : formatTokens(used)}/${formatTokens(contextWindow)} · / for more details`;
	return truncateToWidth(theme.fg("dim", line), Math.max(0, width), theme.fg("dim", "…"));
}

/** Badge labels for the current engine state (exposed for tests). */
export function badgeLabels(engine: ModeEngine): string[] {
	const badges: string[] = [];
	if (engine.yolo) badges.push("yolo");
	if (engine.mode === "plan") badges.push("plan");
	return badges;
}

export function renderBadges(engine: ModeEngine, theme: FooterThemeSlice, width: number, line: string): string {
	const labels = badgeLabels(engine);
	if (labels.length === 0) return line;
	const badgeText = labels.map((label) => theme.fg(label === "yolo" ? "error" : "success", label)).join(" ");
	const badgeWidth = labels.join(" ").length + 1; // leading space
	if (width - visibleWidth(line) < badgeWidth) return line;
	return line + " ".repeat(width - visibleWidth(line) - (badgeWidth - 1)) + badgeText;
}

/** Component factory for ctx.ui.setFooter(); repaints when badges change. */
export function createBadgeFooter(
	ctx: FooterContextSlice,
	engine: ModeEngine,
): (tui: FooterTuiSlice, theme: FooterThemeSlice) => { render(width: number): string[]; dispose?(): void } {
	return (tui, theme) => ({
		render(width: number): string[] {
			if (width <= 0) return [];
			const line = renderFooterLine(ctx, theme, width);
			return [renderBadges(engine, theme, width, line)];
		},
		dispose: engine.subscribe(() => tui.requestRender()),
	});
}
