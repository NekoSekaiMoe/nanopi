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
import type { RunMode } from "./types.ts";

/**
 * The colors the footer needs. `fg` takes the real theme token names, so a
 * badge carries the color of what it means instead of borrowing `error`.
 */
export interface BadgeThemeSlice {
	fg(color: "error" | "success" | "warning" | "bashMode", text: string): string;
}

/**
 * The one label the footer shows, or undefined when there is nothing to say.
 *
 * A run mode replaces `standard` rather than adding to it (`plan` and `minimal`
 * restrict the same tool set in different ways), so at most one is in effect.
 * `yolo` is a separate property of the run — it skips the permission prompt and
 * leaves whatever mode is on untouched — so it gets a label of its own beside
 * the mode.
 */
export function badgeLabels(engine: ModeEngine): Array<RunMode | "yolo"> {
	const badges: Array<RunMode | "yolo"> = [];
	if (engine.yolo) badges.push("yolo");
	if (engine.mode !== "standard") badges.push(engine.mode);
	return badges;
}

/**
 * Colored badge text for the status channel, or undefined when no badge applies.
 *
 * Shell mode (`!` at the composer) takes the whole slot: its yellow `shell`
 * label says more about what the next command will do than the mode does, and
 * the badge was right behind it in the same color, so the footer read as two
 * yellow words. The badge returns when the composer leaves shell mode.
 */
export function modeBadgeText(engine: ModeEngine, theme: BadgeThemeSlice, shellMode = false): string | undefined {
	if (shellMode) return undefined;
	const labels = badgeLabels(engine);
	if (labels.length === 0) return undefined;
	return labels.map((label) => theme.fg(badgeColor(label), label)).join(" ");
}

/** The yellow every footer draws shell mode in; `bashMode` is that token. */
export function shellLabel(theme: BadgeThemeSlice): string {
	return theme.fg("bashMode", "shell");
}

/** yolo red, plan green, minimal blue: one hue per mode, none of them shared. */
function badgeColor(label: RunMode | "yolo"): "error" | "success" | "warning" {
	if (label === "yolo") return "error";
	if (label === "plan") return "success";
	return "warning";
}
