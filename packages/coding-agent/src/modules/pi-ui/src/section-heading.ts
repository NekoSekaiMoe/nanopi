/**
 * `/status` section headings: palette color or pi-ui's frame gradient.
 *
 * `/status` draws its named sections ([Context], [Skills], …) with
 * `theme.fg("mdSectionHeading", …)` — a token of its own, so a reskin can color
 * those headings without touching markdown headings in the transcript. The
 * token defaults to `mdHeading`, so the palette wins unless the user asks for
 * the gradient.
 *
 * The gradient is drawn one escape per character. That is only safe where the
 * caller owns the whole string: `/status` passes the heading text through
 * untouched, but a transcript heading goes through the markdown renderer, which
 * strips a style prefix off the tail of a line and cannot see per-character
 * escapes. So this module has no markdown hook — the gradient belongs to the
 * status dialog alone.
 */

import type { ModuleSettingsSurface, Theme } from "@nanopi/pi-coding-agent";
import { FRAME_STOPS, gradientText } from "./gradient.ts";

const SETTING_ID = "pi-ui:section-heading";
const PALETTE = "palette";
const GRADIENT = "gradient";
const TOKEN = "mdSectionHeading";

/** The theme the choice applies to; replaced on every session_start. */
let current: Theme | undefined;
/** The theme's own `fg`, captured before pi-ui replaces it. */
let originalFg: Theme["fg"] | undefined;
let gradientEnabled = false;
let registered = false;

/** Route `mdSectionHeading` through the chosen style, leaving every other token to the theme. */
function apply(theme: Theme): void {
  current = theme;
  originalFg = theme.fg.bind(theme);
  if (!gradientEnabled) return;
  theme.fg = (color, text) =>
    color === TOKEN ? gradientText(text, FRAME_STOPS) : (originalFg as Theme["fg"])(color, text);
}

export function installSectionHeadingStyle(pi: ModuleSettingsSurface, theme: Theme): void {
  if (!registered) {
    registered = true;
    pi.registerSettingsItem({
      id: SETTING_ID,
      label: "Status section headings",
      description: "How /status paints [Context], [Skills] and the other section headings",
      currentValue: PALETTE,
      values: [PALETTE, GRADIENT],
      onChange: (value) => {
        gradientEnabled = value === GRADIENT;
        if (current) apply(current);
      },
    });
  }
  apply(theme);
}
