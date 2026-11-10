# Agent Note: Markdown's cache lives and dies with the theme instance

Status: implemented

## Problem

A block that `Markdown` had already rendered kept its colors after the terminal
reported its colors, and a reflow that arrived while a pass was producing rows
could pick up rows from the previous theme.

Two independent causes, both in `packages/tui/src/components/markdown.ts`:

- The render cache was keyed on `(text, width)` only. Rows carry the ANSI the
  theme produced, and `getMarkdownTheme()` (`theme.ts`) hands out style functions
  that read the *current* theme instance when they are called, so a regenerated
  system theme (`refreshSystemTheme()`, called from
  `InteractiveThemeController.applyTerminalColors()`) changes what every row of
  an already-rendered block would look like. The block kept returning the rows
  from the old instance: `render` saw the same text at the same width and
  short-circuited. Components that rebuild their `Markdown` per `invalidate()`
  (`UserMessageComponent`, the summary/custom message components) refreshed by
  accident, which is why the bug showed up as a half-old, half-new transcript
  rather than as uniformly stale text. #629 made it reachable for assistant
  text: those blocks now reuse the instance instead of rebuilding it.
- `invalidate()` cleared `cachedText`, `cachedWidth` and `cachedLines` but not
  `cachedRun`, the settled tokens' rows. The rows of the settled prefixes are
  styled text too, so a pass that resumed from the cached run after an
  `invalidate()` pushed rows styled with the old theme into the new frame, and
  the result differed from what a fresh component over the same text renders.

The same `cachedRun` gap also broke a contract `setText` relied on: the resume
path compares the previous source's prefix with the new one, so a cleared
`cachedText` next to a live `cachedRun` left the two caches describing different
passes.

## Decision

`Markdown` records the theme instance it rendered with and treats the rendered
output as stale as soon as the instance it is asked to render with is a
different one.

- `renderedTheme` is compared at the top of `render`, before the cache check and
  before the resume path, and the rows are dropped when it differs. The
  comparison is written as `const currentTheme = this.theme; if
  (this.renderedTheme !== currentTheme) …` because a field read that the JIT sees
  as a store barrier right after a conditional store can be seeded with the
  replaced value; going through a local makes the comparison see the field.
- `renderedTheme` is assigned only by a finished pass, so the rows a caller gets
  back always match the instance recorded for them. A cache hit therefore cannot
  overwrite the record with a theme its rows were not rendered with.
- `CachedRun` gains the theme it was rendered with, and `extendCachedRun` drops
  the settled rows when either the width or the theme differs — the same rule
  that already governed the width, for the same reason.
- `invalidate()` drops the render cache only. `cachedRun` is kept on purpose: it
  is not what `invalidate()` is for. The invalidation that matters for a stale
  theme is the `renderedTheme` comparison, and clearing both entries whenever
  either one changes keeps the two caches describing the same pass.
- `setText` is a no-op for an identical string, matching `Text.setText`
  (#656): a caller that re-sets an unchanged string every frame stops paying for
  the render, and the streaming highlight path reaches this method on every
  frame.

## Alternatives considered

- **Drop the theme from the cache key and rely on the caller invalidating.**
  Rejected: that is the state this change fixes. `TUI.invalidate()` reaches the
  chat container's children, but nothing reaches a `Markdown` that a component
  reuses through `setText`, which is exactly what #629 introduced.
- **Have every component that holds a `Markdown` push a new theme into it
  (`setMarkdownTheme`) from its own `invalidate()`.** Rejected: it repeats the
  same three lines in six components and gets forgotten in the seventh;
  `Markdown` can observe the instance itself, and the theme contract in
  `theme.ts` already says renderers may compare identities.
- **Make `invalidate()` keep the render cache when the text has not changed.**
  Rejected in #656 for `Text`, and it holds here: `invalidate()` is called by
  callers that know their inputs moved (a resize, a scheduled callback), not by
  callers that know the output is unchanged.
- **Key the cache on the theme's *rendered colors* (serialize the palette) so
  two structurally identical themes share rows.** Rejected: it pays an O(palette)
  walk on every render to save a render that only happens when the palette
  actually changed, and it would let a theme with a different `highlightCode`
  but the same colors reuse rows.

## Consequences

- A terminal that reports its colors after startup (the common case: the system
  theme starts in grayscale, `refreshSystemTheme` installs the colored instance)
  now repaints every Markdown block on the next frame without anyone calling
  `invalidate()`. Measured as one full re-render of the visible transcript per
  color report, which happens once per report, not per frame.
- `setText` no longer forces a re-render for an identical string. A caller that
  mutates the `MarkdownTheme` object in place and calls `setText` to force a
  repaint now gets nothing; the supported signal for "the theme moved" is a new
  instance, which is what `theme.ts` installs.
- `cachedRun` still holds rows for the current theme after an `invalidate()`,
  so a reflow that only clears the render cache resumes from the settled rows
  instead of re-rendering the whole block — the behavior
  `markdown-render-resumes-from-settled-blocks` relies on.

Regression tests: `packages/tui/test/markdown.test.ts`, "Theme".
