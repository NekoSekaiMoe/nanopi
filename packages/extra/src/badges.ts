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

/**
 * The colors a badge needs. `fg` takes the real theme token names, so yolo
 * keeps the theme's accent color instead of borrowing `error`.
 */
export interface BadgeThemeSlice {
	fg(color: "accent" | "success" | "warning", text: string): string;
}

/**
 * Badge labels for the current engine state (exposed for tests).
 *
 * `yolo` and the run mode are orthogonal (yolo off does not leave plan or
 * minimal), so both may show at once. `standard` is the absence of a mode
 * badge: it is what every session starts in, and a badge that is always on
 * says nothing.
 */
export function badgeLabels(engine: ModeEngine): string[] {
	const badges: string[] = [];
	if (engine.yolo) badges.push("yolo");
	if (engine.mode !== "standard") badges.push(engine.mode);
	return badges;
}

/** Colored badge text for the status channel, or undefined when no badge applies. */
export function modeBadgeText(engine: ModeEngine, theme: BadgeThemeSlice): string | undefined {
	const labels = badgeLabels(engine);
	if (labels.length === 0) return undefined;
	return labels.map((label) => theme.fg(badgeColor(label), label)).join(" ");
}

function badgeColor(label: string): "accent" | "success" | "warning" {
	if (label === "yolo") return "accent";
	return label === "plan" ? "success" : "warning";
}
