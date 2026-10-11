# Agent Note: pi-ui keeps its open gradient editor with the menu above the input

Status: implemented

> Superseded the same day by
> [composer-menu-above-no-piui-editor](./2026-10-11-composer-menu-above-no-piui-editor.md):
> the user's "loop 中为渐变" meant the Working-line shimmer, and the pi-ui input
> frame itself was unwanted. The menu-above direction moved into the core
> composer; this note records the intermediate step.

## Problem

Commit `0d669b591` ("Ui changes") restyled the vendored pi-ui editor from the
open gradient frame to a thin dim `┌─┐` box and, with it, moved the
slash-command autocomplete menu back below the input (the base `Editor`
layout). The user's reference — their installed pi-ui under
`~/.pi/agent/packages/pi-ui` — has the gradient frame with the menu drawn
above the input, so the single-file build matched neither: the menu popped
downward and the frame had no gradient.

## Decision

`extras/pi-ui/src/editor.ts` is restored to the gradient version vendored at
`421d12a43` (byte-identical to the user's installed copy): gradient
`FRAME_STOPS` top/bottom rules, a solid accent left gutter, the model toolbar
embedded in the frame, and the autocomplete menu rendered above the frame —
padded to `getAutocompleteMaxVisible()` rows so the frame does not shift while
the menu opens and closes.

New on top of the restore: `ReferenceEditor.handleMouse` remaps rows onto the
base Editor's below-the-border geometry, so menu clicks and cursor placement
keep working with the menu on top. It records the padding/menu row counts
during render and translates event rows (`renderedVisibleLineCount` is now
`protected` in pi-tui for exactly this). The restored upstream version had no
mapping and mis-routed menu clicks into text positioning.

The footer simplification and thinking-row reskin from `0d669b591` are
unchanged; only the editor frame and menu direction are restored.

Related: [codex-welcome-footer-status](../feature/2026-10-11-codex-welcome-footer-status.md)
recorded the thin-box pi-ui match this note replaces for the editor.

## Alternatives considered

- Keep the thin box and only move the menu up: rejected — the user's reference
  is the gradient frame ("loop 中为渐变"); they asked why the gradient did not
  take effect, not for a hybrid of both restyles.
- Implement the upward menu as a pi-tui `Editor` option shared with the default
  composer: deferred — pi-ui already owns this layout, and a base option would
  need its own geometry contract and tests; revisit if the default TUI wants an
  upward menu.

## Consequences

- Benefit: the single-file build matches the user's pi look (gradient frame,
  menu above the input), and menu mouse clicks work in that layout for the
  first time.
- Cost: the menu geometry is duplicated between pi-ui's `render` and
  `handleMouse`; a pi-tui option would remove the duplication. Extras sit
  outside the root tsconfig include (`packages/*/src/**`), so the editor is
  typechecked by a manual `tsc -p` invocation with a paths-mapped config, not
  by `pnpm run check`.
