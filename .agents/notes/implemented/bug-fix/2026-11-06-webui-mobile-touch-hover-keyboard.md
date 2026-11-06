# Agent Note: Webui mobile touch targets, hover-device split, soft-keyboard shell

Status: implemented

## Problem

Issue #554's adaptation audit ranked six mobile gaps; the user asked for the
first three. All three are things a phone user hits directly:

1. Touch targets below 44px outside the composer. Permission buttons, follow-up
   option chips, model-sheet rows, sidebar session rows (`min-h-[2.125rem]` =
   34px), rename field and context-menu rows were `h-8`/`size-7`.
2. Hover was not split by device. `globals.css` defined the `can-hover` custom
   variant but nothing used it. The sidebar session timestamp and the `...`
   (rename/delete) menu were `opacity-0` + `group-hover:opacity-100`; a phone
   has no stable hover, so the only entry to rename/delete a session was
   invisible (reachable only via iOS sticky-hover luck). CSS `:hover` fills in
   `.press` and the code-block copy button had the same stuck-hover problem.
3. No soft-keyboard handling. The shell was `h-dvh` fixed height; iOS Safari
   does not shrink `dvh` while the keyboard is open, so the composer docked at
   the shell's bottom is covered while typing. No `interactiveWidget` and no
   `visualViewport` listener existed.

## Decision

- Gap 3 (cross-file contract): `viewport.interactiveWidget = "resizes-content"`
  makes Chrome/Android shrink `dvh`. For iOS, an inline head script (runs
  before paint, so it has no module and no types) tracks
  `window.visualViewport.height` on `(pointer: coarse)` devices only, publishes
  `--app-height`, and toggles `.keyboard-open` when the viewport is covered by
  more than 120px. `globals.css` adds `.h-app` (`height: var(--app-height,
  100dvh)`) and `.keyboard-open .overlay-fullscreen { height: var(--app-height,
  100dvh) }`; the shell (`app-client.tsx`) and the three full-bleed fixed
  overlays (nav drawer, `model-picker.tsx`, `settings.tsx`) opt in. Desktop
  keeps `100dvh` because pinch-zoom shrinks its visual viewport without
  shrinking the layout viewport. The model sheet's `80dvh` cap is now
  `min(80dvh, calc(var(--app-height,100dvh) - 2rem))` so the sheet is never
  taller than the keyboard-free viewport.
- Gap 2: the sidebar timestamp and `...` button are `opacity-100` by default
  and only `can-hover:opacity-0 can-hover:group-hover:opacity-100`
  (`+ group-focus-within` for keyboard users) on hover-capable devices. The
  CSS `:hover` fills (`.press`, `.press-fill`, `.press-brand`,
  `.code-block-head button`) are wrapped in `@media (hover: hover)` so a tap
  does not leave a permanent hover state; `[data-open]` and `:active` fills
  stay unconditional.
- Gap 1: mobile (`max-md`) bumps to `min-h-11`/`h-11`/`size-11` (44px) on
  session rows, the rename field, session-menu rows, permission buttons,
  follow-up chips and buttons, and model-sheet rows. Desktop geometry is
  unchanged; the same `max-md:` pattern the composer already used.

The wiring is guarded by `packages/webui/test/mobile-shell.test.ts`: it runs
the inline script against a fake `visualViewport`/`window` (publish, keyboard
flag, resize, fine-pointer skip) and asserts the script/CSS/component
contracts. Without it, a rename of `--app-height` or a dropped
`overlay-fullscreen` class silently breaks the keyboard fix.

## Alternatives considered

- **CSS `100dvh` + `interactiveWidget: "resizes-content"` alone**: rejected —
  it fixes Chrome/Android but iOS Safari keeps `dvh` at the full screen height
  with the keyboard open, which is the exact reported symptom. A
  `visualViewport` measurement is the only cross-browser source for the real
  visible height.
- **React `useEffect` visualViewport listener** (e.g. in `AppClient`):
  rejected — it runs after first paint, so the composer is visibly mispositioned
  on load, and it duplicates the theme bootstrap that already has to be an
  inline head script; the inline script shares that placement and runs earlier.
- **Gate hover behavior on width (`max-md`) instead of `(hover: hover)`**:
  rejected — a touch laptop or a tablet with a trackpad has hover at desktop
  widths, and a narrow desktop window has no touch; capability, not width, is
  the property that decides whether `opacity-0` is reachable. The `can-hover`
  custom variant already existed for exactly this.
- **Bump all small controls to 44px at every width**: rejected — it would
  reflow the dense desktop sidebar and settings forms unnecessarily; `max-md:`
  keeps the two geometries independent, matching the existing composer pattern.
- **Fix gaps 4-6 too (12px inputs, wide-screen, file/terminal back button)**:
  rejected — the user asked for 1, 2, 3 only; those remain separate work.

## Consequences

- Benefit: rename/delete is visible on touch; tap targets meet 44px on mobile;
  the composer stays above the keyboard on iOS; hover states no longer stick
  after a tap.
- Cost: one inline script and three new CSS rules to keep in sync; the
  `--app-height` contract spans `layout.tsx`, `globals.css`, and four
  components, which is why the regression test exists. The script assumes
  `visualViewport.height` is in CSS pixels on touch devices and that a >120px
  deficit means a keyboard (browser chrome also counts, which is equally worth
  following). Fine-pointer browsers keep the old `dvh` behavior unchanged.
- Testing: `pnpm --filter @nanopi/webui exec vitest --run
  test/mobile-shell.test.ts` (10 cases); `pnpm run typecheck` (webui) passed;
  `pnpm run check` passed through `check:browser-smoke` and only fails the
  final `check:openai-client-size`, which needs a prebuilt
  `packages/ai/dist/api/openai-chat-completions-client.js` in this fresh
  checkout (unrelated to this change).

Related: [webui-arkloop-restyle](../feature/2026-10-12-webui-arkloop-restyle.md)
(where the 768px shell and `h-dvh` layout originated).
