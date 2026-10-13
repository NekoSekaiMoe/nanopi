/**
 * Mode badges for the footer status channel (`ctx.ui.setStatus()`).
 *
 * The extension must not install its own footer: `setFooter()` is a replacing
 * setter, so the last module calling it wins and every other custom footer is
 * silently dropped (pi-ui ships one; extra would clobber it or be clobbered).
 * Badges flow through the status channel instead — plain strings any
 * installed footer can render — with colors embedded by the producer via
 * `theme.fg()` (same convention as pi-rewind's checkpoint status).
 */

import type { ModeEngine } from "./mode-engine.ts";

export interface BadgeThemeSlice {
	fg(color: "error" | "success", text: string): string;
}

/** Badge labels for the current engine state (exposed for tests). */
export function badgeLabels(engine: ModeEngine): string[] {
	const badges: string[] = [];
	if (engine.yolo) badges.push("yolo");
	if (engine.mode === "plan") badges.push("plan");
	return badges;
}

/** Colored badge text for the status channel, or undefined when no badge applies. */
export function modeBadgeText(engine: ModeEngine, theme: BadgeThemeSlice): string | undefined {
	const labels = badgeLabels(engine);
	if (labels.length === 0) return undefined;
	return labels.map((label) => theme.fg(label === "yolo" ? "error" : "success", label)).join(" ");
}
