# Agent Note: Mode badges own their hue instead of borrowing a semantic token

Status: implemented

## Problem

The footer badges were colored by whatever semantic token was closest:
`yolo` took `error` (red), `plan` took `success` (green), `minimal` took
`warning`. Those tokens are not hues, they are roles:

- The system theme generates every token from the terminal's palette. `warning`
  belongs to the yellow family, which takes its hue from palette slot 3. On a
  palette whose slot 3 is not warm — Dracula's `#bd93f9`, for example — the
  "blue" minimal badge came out violet, and the same slot painted `shell`.
- `error` and `success` are the same color as failure and success states. A red
  `yolo` badge next to a red error message says the mode is a problem.

The mode badges are the one place in the footer where the hue *is* the message
"which mode am I in". Anything that can move it weakens the message.

## Decision

Three new theme tokens — `modeYolo` (red), `modePlan` (green), `modeMinimal`
(blue) — plus `bashMode`'s yellow, are *fixed* in the system theme:

```ts
const FIXED_TOKENS: Partial<Record<ThemeToken, FamilyName>> = {
	bashMode: "modeYellow",
	modeYolo: "modeRed",
	modePlan: "modeGreen",
	modeMinimal: "modeBlue",
};
```

`paint()` skips the palette for them and uses the family's own hue and a flat
saturation. Everything else about them stays derived: lightness still comes from
the `readable` contrast rule, so the badge reaches the same contrast on any
background the theme supports, and `saturation: 0` still grays the whole UI.

The three mode families carry the pale-palette lesson from
[the pastel test](../../../../packages/coding-agent/test/system-theme.test.ts):
their `min` equals their `max`, so the bell weight cannot raise chroma at mid
lightness, and the badge is the same saturated red/green/blue everywhere rather
than washed out on pale backgrounds.

Terminals that report no colors use the tier-3 path: fixed palette indices
(`1`, `2`, `4`, `3`) instead of the family's slot, since the badge is pinned to
a hue family rather than to a palette entry.

`bashMode` joins them because it is the other half of the same slot: the `shell`
label replaces the badge, so it has to stay yellow regardless of what the
palette says index 3 is. The badge and the shell label can no longer collide by
accident either — `modeMinimal` is blue now, not the yellow `warning` family
was.

## Alternatives considered

- **Add a semantic `info` token and map minimal to it**: rejected as the same
  mistake one level up. The badge would still follow the palette's slot 4 and
  turn teal on a theme that recolored it; the problem was that the badge's color
  is a name, not a role.
- **Let the extension pass hex colors through `theme.fg()`**: rejected — the
  extension API's `theme` slice is token names by design (it renders through the
  host's `Theme`), and a hex literal would have to be duplicated per appearance,
  with no contrast rule to keep it readable.
- **Only pin hue, leave saturation to the palette**: rejected for the reason
  above; a pastel palette would show a pastel "red" that no longer reads as yolo.

## Consequences

- Every terminal keeps yolo red / plan green / minimal blue / shell yellow, at
  the lightness its background needs. A palette that recolored those slots no
  longer recolors the footer.
- One-color-per-meaning is now enforced where it belongs: the theme owns the
  hue, the producer (pi-extra) only chooses which badge to show.
- `BadgeThemeSlice` in `packages/extra/src/badges.ts` lists the new token names,
  replacing `error`/`success`/`warning`.
- Adding a mode means adding a `mode*` token and a family, which is the point:
  the color is a decision, not a byproduct of which semantic token was free.
