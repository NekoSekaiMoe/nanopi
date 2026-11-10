# Agent Note: `Text.invalidate()` redraws the same text, `setText` swaps it

Status: implemented

## Problem

`Text` had one cache-clearing entry point doing two jobs. `invalidate()` and
`setText()` both cleared `cachedText`, `cachedWidth`, and `cachedLines`, so
"the thing I display changed" and "draw what I display again" were the same
instruction. Two consequences:

- Every caller had to reimplement the "did it change" guard. `renderers/bash.ts`
  keeps one (`if (text !== previous) component.setText(text)`, with a comment
  about the wrap cache); `renderers/write.ts` has none and calls `setText` on
  every rendered frame from `formatWriteCall`, so the wrap of the rendered card
  is recomputed whether or not the text moved. Adding the guard to `write`
  would only copy a fix that belongs to the component.
- `invalidate()` was a promise the cache would not be trusted. The interface
  doc says "invalidate any cached rendering state", and `Line*` components
  (`Markdown`, `Box`, `MouseRegion`) honor it. Naming a same-text path
  `invalidate` and having it return the cache contradicts that reading for the
  one component most other components are built on (`Loader`, `ThemedText`,
  `ShellCallRenderComponent`, `WriteCallRenderComponent`).

## Decision

Two entries, two meanings, and `Text` owns both.

- `setText(text)` — the content changes. Same string is a no-op: the cache is
  keyed by text and width, so a fresh render would reproduce exactly those
  lines. Callers that re-set an unchanged string every frame stop paying for
  the wrap.
- `invalidate()` — the content does not change; draw it again. It still clears
  the wrapped lines, so the next `render` re-wraps and re-applies the background
  callback instead of returning lines it cannot vouch for.

The cost of an unchanged `setText` is one string comparison. The cost of an
extra `invalidate` is a re-render, which is what the caller asked for. Both are
acceptable in a frame; a wrong answer in either direction is not.

Because `invalidate()` leaves the text alone, a subclass whose render reads
state it rebuilds during invalidation must say so itself: `ThemedText` sets
`stale` in an override and rebuilds from `build`, and `Loader` overrides
`invalidate()` to rebuild its spinner and message. Both already did.

## Alternatives considered

- **Keep one entry point and add the guard at call sites.** Rejected: it leaves
  the trap in place for the next renderer. `bash.ts` proves the guard gets
  duplicated, `write.ts` proves it gets forgotten, and neither is a local
  decision — the component knows whether its own cache is still valid.
- **Make `invalidate()` keep the cache too (only `setText` clears it).**
  Rejected: `invalidate()` has no way to know the text is still current for the
  caller's purposes. `TUI.invalidate()` on a resize or theme change, and
  `context.invalidate()` from a callback a render scheduled (a lazily loaded
  grammar, an async diff), both mean "the inputs moved, produce lines again".
  Returning the old lines would be silently wrong, and the same-text call site
  is already served by the `setText` guard.
- **Give `Text` a separate no-op `setText` subclass hook and leave the
  interface alone.** Rejected: `WriteCallRenderComponent` and `ThemedText` both
  extend `Text` and both call `setText`; a hook adds an override layer without
  changing what either of them does.
- **Reconcile `Markdown.invalidate()` with `Text.invalidate()` by making both
  same-text caches.** Rejected for now: `Markdown` is the same setup, but its
  invalidation is called from a width-keyed preview cache
  (`ask-lite/.../markdown-content-cache.ts`), which re-renders after an explicit
  `invalidate()`; changing its meaning needs that caller audited too. Not part
  of this change. `Markdown` later gained the same "identical string keeps the
  rows" rule on its own `setText`, together with a theme-instance key for the
  cache; see `../bug-fix/2026-11-10-markdown-cache-holds-theme-instance.md`.
  Its `invalidate()` still drops the cache outright.

## Consequences

- Benefit: `write`'s per-frame `setText` keeps the wrapped lines whenever the
  rendered card is byte-identical, including the frames where only output and
  not arguments moved. No call site needs its own guard.
- Cost: `setText` is now a no-op for an identical string. A subclass that
  mutates the text behind `Text`'s back and calls `setText` to force a redraw
  would silently stop redrawing; `ThemedText` is the one such subclass and it
  rebuilds through `build()` before calling `setText`, so it never passes the
  same string twice for that reason.
- Cost: `invalidate()` is still a full re-wrap, not an incremental one. A theme
  change re-wraps every `Text` on screen, exactly as before.
- Tested by `packages/tui/test/text-cache.test.ts`: an unchanged `setText`
  returns the cached array, a changed one grows it, and `invalidate()` renders
  again rather than returning the previous lines.

## Related

Follows [Markdown resumes rendering from the settled blocks](../simplification/2026-11-10-markdown-render-resumes-from-settled-blocks.md),
which handles the same "streamed text re-renders every frame" problem for
`Markdown`, and the `write`/`bash` call-text reuse work in shinytale/nanopi#633
and shinytale/nanopi#652, which needs this component-level guarantee.
