# Agent Note: message bodies reuse one `Markdown` and follow the theme

Status: implemented

## Problem

Every message component in the transcript rebuilt its body from scratch:
`UserMessageComponent.rebuild()`, `SkillInvocationMessageComponent.updateDisplay()`,
`CustomMessageComponent.rebuild()`, `BranchSummaryMessageComponent.updateDisplay()`
and `CompactionSummaryMessageComponent.updateDisplay()` all did
`clear()` + `new Markdown(...)`. `extras/pi-ui`'s expanded thinking row did the
same. Each new instance starts with an empty token cache, so the work a previous
instance had already done was thrown away on every rebuild. That is the same
defect shinytale/nanopi#629 fixed for the assistant body, left standing in the
five components around it.

The reason it had not been fixed is the second half of the problem: a component
that keeps its `Markdown` also keeps rows that were styled with the theme
instance they were rendered under. `InteractiveThemeController` regenerates the
system theme and calls `TUI.invalidate()`, which invalidates the component tree
but rebuilds nothing. `Markdown.invalidate()` cleared `cachedLines` but left
`cachedRun` (the token tree plus the rows the settled tokens rendered to), and
`getDefaultStylePrefix()` memoized outside every cache field. So a kept block
would have shown the previous theme's colors after a theme switch, while the
blocks that were still rebuilt every pass picked up the new one — half a screen
in each theme.

## Decision

`Markdown` owns the theme half of its cache, and the components own the reuse.

- `Markdown.setTheme(theme)` installs a theme. `render()` compares the theme
  object the caches were produced with and drops `cachedLines`, `cachedRun` and
  the memoized style prefix when it changed. `getDefaultStylePrefix()` checks the
  theme too, since it memoizes outside the cache fields.
- `Markdown.invalidate()` is unchanged: it clears the width/text caches and, as
  before, keeps `cachedRun`. A streamed block still resumes from its settled
  prefix, which is what `markdown-render-resumes-from-settled-blocks` bought.
- `UserMessageComponent` and `SkillInvocationMessageComponent` keep one body and
  call `setText` + `setTheme`. `SkillInvocationMessageComponent` also keeps its
  header row and its `MouseRegion` wrapper instead of rebuilding the clickable
  tree per toggle.
- `CustomMessageComponent`, `BranchSummaryMessageComponent` and
  `CompactionSummaryMessageComponent` gain `setMarkdownTheme(theme)`. These three
  redraw unconditionally (`rebuild()` / `updateDisplay()` already runs on every
  `invalidate()`), so the setter only has to hand the new theme over; it does not
  need to track which rows it drew.
- `AssistantMessageComponent.blockKey()` includes an identity token for the
  markdown theme, and it gains `setMarkdownTheme`. A block kept across passes is
  rendered with the theme it was built with, so a theme switch has to drop it
  once. Passes that hand over the same theme object keep their components. The
  transcript makes one theme object per message, so this is not a per-delta
  identity change.
- `AssistantMessageRenderContext.renderMarkdown(key, text, style?)` draws a
  markdown block through the same reuse. `extras/pi-ui`'s expanded thinking row
  uses it instead of `new Markdown`, which is the shinytale/nanopi#628 leftover.
- `InteractiveMode.refreshMessageMarkdownThemes()` walks the transcript and the
  pending-message container and calls `setMarkdownTheme` on whoever has one. It
  runs from the theme controller's `onChanged`, i.e. right after
  `refreshSystemTheme()` and before the `TUI.invalidate()` / `requestRender()`
  pair that follows every theme change. It does not request a repaint itself:
  every caller is already inside that pair.
- `InteractiveMode.getMarkdownThemeWithSettings()` memoizes its result. It is
  called per message; a fresh object per call would make every component compare
  a different theme and drop its cache for nothing.

## Alternatives considered

- **Make `Markdown.invalidate()` clear `cachedRun` too, so a theme switch needs
  no new entry point.** Rejected: `TUI.invalidate()` also fires on a resize and
  on every `context.invalidate()` a render scheduled (a lazily loaded grammar, an
  async diff). Clearing the run there reintroduces the O(n^2) lexer cost on
  every resize of a long transcript, and it does not fix the memoized style
  prefix or tell the component when the theme actually moved.
- **Let `Markdown` follow the `theme` proxy instead of taking an instance.**
  Rejected: a cached row is a string of ANSI, and a proxy gives no way to tell
  whether the colors behind it changed. Identity of the installed object is the
  signal `theme.ts` already documents ("renderers can compare identities"), and
  it is what `write.ts` / `bash.ts` already use.
- **Give every component a `setMarkdownTheme` that also clears its own tree.**
  Rejected for the three `Box`-shaped components: they rebuild on every pass
  anyway, so the clearing would be redundant. It is not redundant for
  `AssistantMessageComponent` and the two `setText` components, which is why
  those three get the theme into their reuse key instead.
- **Keep `new Markdown` in `pi-ui`'s thinking row and fix it in a later PR.**
  Rejected: it is one line against `renderMarkdown`, and leaving it out means the
  expanded reasoning is the one block that still re-lexes per delta.
- **Rebuild the whole transcript on a theme change instead of handing the theme
  over.** Rejected: `rebuildChatFromMessages()` throws away tool execution
  components, their output and their live state, which a color change has no
  reason to touch.

## Consequences

- Benefit: a theme switch repaints the transcript in the new theme for every
  message kind, including the ones that now keep their component.
- Benefit: an unchanged message body keeps its token cache. The user message,
  the skill body and the expanded thinking row no longer re-lex on every
  re-layout or expand/collapse.
- Cost: `Markdown` carries two more fields (`renderedTheme`, `prefixTheme`), and
  a caller that renders with a theme object different from the installed one
  pays for one wasted pass before the check catches up. `setTheme` is the entry
  point that avoids it.
- Cost: the theme object is now part of a block's identity. A caller that
  constructs a fresh markdown theme per pass would drop every cache; the memo in
  `getMarkdownThemeWithSettings()` and the single object the transcript passes
  into a message exist to prevent that.
- Not covered: `extras/ask-lite`'s `MarkdownContentCache` keeps its own
  width-keyed `Markdown` and calls `invalidate()` on it. It is a preview surface
  that re-renders after the invalidate, so its semantics do not change with this
  note, but it does not follow a theme switch either. Left as is.
- Tested by `packages/tui/test/markdown-theme-cache.test.ts` (a new theme
  re-renders, the same theme keeps the object), `collapsible-message-components.test.ts`
  (both summaries redraw with a new theme, a skill body survives a collapse),
  `assistant-message.test.ts` (a kept block re-renders with a new theme) and
  `user-message.test.ts` (a padding change re-sets the body).

## Related

Follows [Text.invalidate() redraws the same text, setText swaps it](2026-11-10-text-invalidate-redraws-settext-swaps.md),
which split the swap and the redraw for `Text`. The assistant body reuse is
shinytale/nanopi#629 and its tail fast path is shinytale/nanopi#630; this note is
step 3 of the plan in shinytale/nanopi#656 and closes the `pi-ui/thinking.ts`
leftover from shinytale/nanopi#628.
