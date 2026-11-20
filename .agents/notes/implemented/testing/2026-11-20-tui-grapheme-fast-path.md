# Agent Note: TUI column helpers skip segmentation for single-column ASCII

Status: implemented

## Problem

Terminal rows drawn by nanopi are often styled ASCII. Before this change, every call to `sliceWithWidth`, `extractSegments`, and `getGraphemeCellRange` ran `Intl.Segmenter` over each text chunk, even when every code unit was a printable ASCII character and therefore already one terminal cell. Layout frames repeatedly composite the same rows, so this work was paid on every repaint rather than only for text with ambiguous grapheme boundaries.

The slow path is material: segmenting a 20k ASCII line costs about 1.5 ms on the local Node runtime; slicing the first 80 cells via the new check is roughly 6x faster in an isolated microbenchmark.

## Decision

`isSingleColumnAscii` recognizes chunks whose code units are all printable ASCII. Column helpers use direct string indexing for such chunks and keep the existing segmenter path for anything else, including tabs, wide characters, combining marks, emoji, and control characters. ANSI codes are still parsed outside both paths, so styling and zero-width APC markers continue to follow the original rules.

The fast path is scoped to the three column helpers. `visibleWidth` already had an ASCII fast path, and `renderLayoutFrame` already cached component output and only composited visible rows; this change avoids re-segmenting the source row while doing that compositing. The `Component.render()` contract stays mutable `string[]`.

## Alternatives considered

- Port upstream `b7bb7ca90` and change `Component.render()` to `readonly string[]`. Stronger long-term contract, but it forces every extension that splices rendered output to copy first and touches most of `packages/tui`. The measured bottleneck in this repository is repeated segmentation, not the render contract.
- Cache segmentation results per rendered line. This would help repeated rows, but adds a cache with invalidation rules and does not help once-per-frame rows. Direct ASCII handling has no shared state and preserves the existing call sites.
- Make a special case only inside `renderLayoutFrame`. That would leave `compositeTuiLine` and text-selection callers paying the same cost, and would couple the optimization to one caller.

## Consequences

Styled ASCII rows avoid grapheme segmentation in the three helpers. Non-ASCII text uses the original behavior, so wide-character boundaries and cursor marker placement remain covered by the existing regression tests.

The benchmark at `packages/tui/test/alt-screen-large-transcript-bench.ts` stays around 0.65 ms/frame for steady and scroll on a 47k-line transcript; most of that time is already outside these helpers. The optimization is therefore a local reduction in per-frame work, not a replacement for viewport-limited layout.
