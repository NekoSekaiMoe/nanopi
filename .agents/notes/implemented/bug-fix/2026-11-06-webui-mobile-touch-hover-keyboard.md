# Agent Note: Webui mobile touch targets, hover-device split, soft-keyboard shell

Status: implemented

## Problem

Issue #554's adaptation audit ranked six mobile gaps; the user asked for the
first three. All three are things a phone user hits directly:

1. Touch targets below 44px outside the composer. Permission buttons, follow-up
   option chips, model-sheet rows, sidebar session rows (`min-h-[2.125rem]` =
   34px), rename field and context-menu rows were `h-8`/`size-7`. A follow-up
   (issue #554 comment, "这个可以统一一下") extended the same rule to the
   remaining secondary 32-36px targets in the mobile drawer that item 1 did not
   name: search/close icon buttons (`size-8`), the search field (`h-9`), quick
   action rows and file-tree rows (`h-8`/`h-9`/`size-7`), delete-confirm buttons
   (`h-8`), nav tabs, and the model-sheet close button (`size-9`).
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
  unchanged; the same `max-md:` pattern the composer already used. The follow-up
  makes this a **completeness invariant**, not an enumerated list: every
  `size-7/8/9`, `h-8/h-9`, `min-h-8`, `min-h-[2.125rem]` control inside the
  drawer (`sidebar.tsx` + the sheet close in `model-picker.tsx`) must carry a
  `max-md:` 44px override on the same line. Icon buttons get
  `max-md:size-11`, pill buttons / the search field get `max-md:h-11`, and the
  `h-8`/`h-9` flex rows get `max-md:min-h-11` — the same "grow, don't clip"
  treatment #559 gave the session row, so a long label can never be cut off.
  A line-scan regression test enforces the invariant so a newly added small
  control cannot silently ship below 44px again.

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
- **Leave the unnamed secondary targets at 32-36px** (treat item 1's five
  groups as a closed list): rejected in the follow-up — the user asked to
  "统一一下". A drawer where session rows are 44px but the search, close,
  file-tree and delete-confirm controls beside them are still 32-36px is
  visibly inconsistent on a phone and is the same defect. Completeness is now
  the rule rather than a fixed enumeration.

## Consequences

- Benefit: rename/delete is visible on touch; every drawer tap target meets
  44px on mobile (not just the five originally named groups); the composer stays
  above the keyboard on iOS; hover states no longer stick after a tap.
- Cost: one inline script and three new CSS rules to keep in sync; the
  `--app-height` contract spans `layout.tsx`, `globals.css`, and four
  components, which is why the regression test exists. The script assumes
  `visualViewport.height` is in CSS pixels on touch devices and that a >120px
  deficit means a keyboard (browser chrome also counts, which is equally worth
  following). Fine-pointer browsers keep the old `dvh` behavior unchanged.
- Testing: `pnpm --filter @nanopi/webui exec vitest --run
  test/mobile-shell.test.ts` (11 cases, 18 in the package); webui
  `pnpm run typecheck` passed; root `pnpm run check` passed fully after a local
  `packages/ai` build (`build:offline`) produced the
  `dist/api/openai-chat-completions-client.js` that the final
  `check:openai-client-size` reads. On a fresh checkout without that artifact
  the final check alone fails, unrelated to the webui change.

Related: [webui-arkloop-restyle](../feature/2026-10-12-webui-arkloop-restyle.md)
(where the 768px shell and `h-dvh` layout originated).
