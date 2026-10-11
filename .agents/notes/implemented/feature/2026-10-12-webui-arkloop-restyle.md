# Agent Note: Webui Arkloop-style restyle, right panel, and wallpaper

Status: implemented

## Problem

The webui's look was the DeepSeek-Harness-derived cool-grey palette with a
clay-orange accent; the user found it ugly and wanted the Arkloop look. A full
frontend swap was rejected during investigation: Arkloop's web app is ~90k
lines bound to its Go `/v1` API (threads, personas, QQ/WeChat channels,
memory), and its license (modified Apache 2.0) forbids removing its LOGO and
copyright from the frontend and lets the producer retighten terms — both
incompatible with nanopi's MIT webui and own branding. The two features the
user wanted "ported" turned out to already exist here in smaller form: a
per-launch bearer token printed in the opened URL, and a 12-entry classical
poetry pool on the landing page.

## Decision

Port Arkloop's *design decisions* onto the existing token system instead of
its code; keep the Preact app and the `--app-*` token contract so the 3.9k-line
app.css re-skins by palette swap.

- `theme.css` now carries the warm monochrome palette (dark base page `#1E1D1C`,
  sidebar `#242422`, input `#30302e`, warm-grey text rungs; light theme warm
  paper `#F5F5F4`), a single ivory/near-black accent pair (`--app-brand`) in
  place of clay-orange buttons, a 14px root type scale (Arkloop density; the
  font-scale picker still multiplies it), and a MiSans-first font stack.
  MiSans itself is NOT bundled (~10 MB CJK variable font): the stack prefers
  it when the user has it installed, else falls back to the system stack.
  This is the one deliberate deviation from "copy the design as-is".
- Shell: the session header is now always present (session title on history,
  `NanoPi` wordmark on landing) and carries a right-actions slot with a right
  panel toggle. The right panel (`RightPanel.tsx`, 300px column, overlay under
  900px) hosts session actions, the working directory, and the skills list;
  its open state persists in localStorage.
- Wallpaper: `html[data-wallpaper='on']` paints a body background image under
  an auto scrim (`--app-background-image-scrim-*`, alpha rises as wallpaper
  opacity drops); panels go translucent + blurred via a `--app-canvas-background`
  indirection so the default (no wallpaper) rendering is unchanged. The picker
  lives in the theme dialog; the data URL is stored in this browser only,
  capped at 4 MB.
- Landing poetry: the pool is structured (`POEMS: {text, source}`, 28 entries)
  and the landing shows the source on its own muted serif line; flat-string
  `GREETINGS`/`randomGreeting` stay for compatibility. The poem types itself
  out (`lib/typewriter.ts`): punctuation-aware pacing, blinking caret, source
  line fading in on completion; `prefers-reduced-motion` shows it instantly.
- Composer ported to the Arkloop chat-input-box design: 20px-radius box,
  hairline border, focus lifts a soft shadow (no ring), textarea starts at one
  row and auto-grows to 300px at 16px absolute type, clicking the chrome
  focuses the field, send is a 34px rounded-lg monochrome chip (press = scale
  + opacity), stop is the outlined secondary chip.
- Tool calls ported to the Arkloop ExecutionCard design: an inline fit-content
  trigger row (colored status word leading, shimmer while running, hover lifts
  the preview color, chevron rotating right→down, keyboard operable) and an
  always-mounted collapsible panel (0fr→1fr grid transition both directions,
  visibility-hidden when collapsed) with a mono uppercase tool label and
  args/output sections. The status icon pair was removed with the port; the
  trigger keeps the tool-type icon.
- Token hardening (the Arkloop-inspired part that was missing): the page moves
  `?token=` into `sessionStorage` on first load and rewrites the URL
  immediately (refresh keeps working; history/screen-share no longer carry the
  credential), and the server compares bearers with `timingSafeEqual`
  (`bearerTokenMatches`, exported for tests). No owner-password/session-cookie
  layer: nanopi's webui is single-user local, the per-launch token is the
  whole model, and Arkloop's setup-token dance exists to bootstrap a persisted
  password nanopi does not have.

## Alternatives considered

- **Swap in Arkloop's `src/apps/web` wholesale.** Strongest reason to want it:
  the look is exactly what the user asked for, already built. Rejected: the
  license's branding clause and retroactive-term clause make it toxic for a
  rebranded fork; and the API adapter rewrite (every screen speaks
  threads/personas/channels protocols nanopi has no backend for) dwarfs the
  restyle. Porting token values costs a theme.css rewrite.
- **Keep clay-orange, only polish (warm neutrals + contrast/spacing fixes).**
  Considered as the conservative option; rejected by the user's explicit pick
  of the Arkloop warm-monochrome direction (monochrome buttons, no bright
  accent).
- **Bundle the MiSans variable font for fidelity.** Rejected for size (~10 MB
  into a webui that today ships ~100 KB gzipped JS); the font stack prefers
  locally installed MiSans instead.

## Consequences

- The entire app re-skins from theme.css alone; components keep the `--app-*`
  contract, and the remaining raw hexes in app.css are shadows and status
  colors that are theme-neutral or now tokenized (`--app-success-contrast-foreground`,
  `--app-error-contrast-foreground`).
- 14px root shrinks all rem-based text ~12.5%; the density is the point
  (Arkloop look), and the existing font-scale picker compensates for users
  who want it larger.
- Caption rungs had to move up to meet the repo's WCAG AA guard test: dark
  `#94928a`, light `#6B6B68` (equal to light tertiary — the Arkloop light
  theme collapses those rungs too).
- Wallpaper data URLs count against localStorage (~5 MB); the 4 MB cap and the
  quota-failure path keep the previous wallpaper when a save fails.
- The token now dies with the browser tab (sessionStorage). New tabs on the
  same server need the terminal URL again; that matches the per-launch token
  lifetime and avoids persisting a credential that outlives the server.
- Verification: `pnpm run check` (incl. biome + tsc + browser smoke),
  webui `pnpm run test` (244 pass, incl. the CSS fallback and contrast guard
  tests that caught two regressions during development), webui
  `pnpm run build`, and `test/webui-auth.test.ts` for the constant-time
  bearer check. The composer/typography guard tests
  (`composerStyles.test.ts`, `typographyStyles.test.ts`) were updated to the
  ported contracts (one-row composer at 16px absolute type, 300px cap) — they
  previously encoded the old two-row shared-rung design. Rendering was not
  eyeballed in a browser in this environment; the user should run
  `nanopi webui` and review dark/light + wallpaper before release.

Related: [apply_patch/edit mutual exclusion](../simplification/2026-10-12-apply-patch-edit-mutual-exclusion-prompt-trim.md)
(same session's prompt-surface work).
