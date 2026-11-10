# Agent Note: Markdown resumes rendering from the settled blocks, not just from the settled tokens

Status: implemented

## Problem

A streamed assistant answer appends to one text block, and every delta renders
the whole block again. #629/#630 made the parse cheap: `Markdown` kept the token
tree and `extendLexedSource` re-lexed only the open tail. The rows were not part
of that pass, so every render still fed every settled token through
`renderToken`, `wrapTextWithAnsi`, and the background/padding loop.

That second half is not noise next to the lexer: `renderToken` is the expensive
one. Measured over 200 deltas of a 200-paragraph answer, 80 columns:

| | `renderToken` calls | rows produced for text of 6.3 KB |
|---|---|---|
| tokens only (#630, before) | 40,200 | 200 per pass |
| tokens + rows (after) | 599 | 3 per pass once the deltas overwrote a paragraph |

The last column is the reason this is not a micro-optimization: at 200
paragraphs the before-number grows with the square of the block count, while the
lexer work #630 already fixed stays linear.

## Decision

One pass leaves two things for the next one, and `Markdown` resumes from both:
the lexer pass (`LexedSource`) and the rows every token but the open last one
rendered to (`CachedRun.rendered`, keyed by the width they were rendered at).

- The reuse unit is exactly `settledCount(tokens)` — the tokens before the block
  an append can still restructure. It is the same boundary the resume already
  trusted for tokens, so a row and its token are never out of step.
- The rows of the last token are never kept. Its output depends on the type of
  the token after it (`nextTokenType` decides the blank line after a heading, a
  table, a paragraph), and that is the one fact an append can change.
- `extendCachedRun` drops the rows when the content width differs, because
  `renderToken` is width-dependent (tables lay themselves out per width). Width
  changes are not a streaming path; the tokens still resume.
- Tokens are trimmed for display (`trimPartialClosingFences`) on a copy of the
  token array, so the kept `LexedSource` stays the untrimmed tree the filter
  expects. The cache is still a `WeakRef` for the reason #630 gave: one token
  tree per message of a long transcript.

`Markdown` therefore assumes a source grows by appending. It does not get the
guarantee for free: `extendLexedSource` compares the previous source's prefix to
the new one and falls back to a full parse when they differ, which is what keeps
`setText` with an unrelated string correct.

## Alternatives considered

- **Key the row cache on each token's `raw` and reuse rows across unrelated
  texts (a plain LRU).** Rejected: it helps only when the same text is rendered
  twice with the same width, and costs a map lookup per token on every render,
  which is a per-token cost on the path we are trying to shorten.
- **Keep every token's rows, including the last one, and patch only the
  difference.** Rejected: the trailing token's output is a function of the
  token after it, so the "difference" is a re-render of the trailing token plus
  a possibly changed trailing blank line — the same work as not keeping it, in
  more code.
- **Invalidate the row cache on the `transform` output rather than on
  `settledCount`.** Rejected: `transform` runs on the whole text before the
  lexer, so a transformer that rewrites the middle of the message already
  defeats `extendLexedSource`; the rows follow the tokens by construction.
- **Reuse the `renderedLines` array instead of a row list per token.** Rejected:
  the settled rows are only reusable if they can be addressed per token; a flat
  array would have to record offsets, which is the same bookkeeping with a copy.

## Consequences

- Benefit: a delta renders only the open block. For an answer of N blocks the
  render work is O(N) total rather than O(N²), on top of what #630 did for the
  lexer.
- Cost: one extra `Token[]` slice and array push per render pass, and the
  per-token row cache lives on the same `WeakRef` — a collected cache falls back
  to a full render, which is the pre-existing behaviour.
- Cost: the invariant moved. A settled token whose output could depend on later
  text would now be visibly stale. Today `renderToken` reads only `width`,
  `theme`, the style context, and `nextTokenType`; a future renderer that reads
  `token.raw.length` or peeks further ahead has to be cached differently.
- Tested by `renders only the tail of an appended text` in
  `packages/tui/test/markdown.test.ts`: it counts `renderToken` calls across 50
  deltas and asserts the total stays linear, plus that no delta shrinks the
  render. The older `renders every append like a fresh component over the same
  prefix` case covers correctness by comparing every prefix against a fresh
  component.
