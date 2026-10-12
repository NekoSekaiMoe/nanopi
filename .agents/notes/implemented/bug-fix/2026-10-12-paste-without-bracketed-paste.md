# Agent Note: Reclassify non-bracketed paste chunks before the editor sees Enter

Status: implemented

## Problem

Pasting multi-line markdown into the interactive input on a terminal that does not wrap pastes in `ESC[200~ ... ESC[201~` markers submitted the draft at the first line break and truncated the rest: without the markers, an embedded CR reaches the editor as the `tui.input.submit` key. nanopi always enables mode 2004, but not every terminal honors it (some multiplexers, consoles, and SSH clients strip or ignore it). Codex avoids this with its `PasteBurst` state machine (`codex-rs/tui/src/bottom_pane/paste_burst.rs`): rapid keystroke streams are buffered, and Enter/Tab inside the burst insert a newline/tab instead of triggering submit/shortcuts.

## Decision

Detect pastes at the `StdinBuffer` layer from chunk shape, not timing:

- A chunk consisting only of printable characters plus embedded CR/LF/TAB with **>= 3 printable characters** is a paste: it is emitted on the existing `paste` event, which `Terminal` already re-wraps with 200~/201~ markers, so it flows through the editor's normal `handlePaste` path (line-ending normalization, tab expansion, large-paste markers, atomic undo).
- Pure CR/LF chunks (>= 2 chars) continue an active paste stream for 150 ms (`PASTE_STREAM_CONTINUATION_MS`) so terminals that split a paste at line boundaries do not leak stray Enter keystrokes.
- Single control characters are never pastes: a typed Enter stays `tui.input.submit`, and a two-printable-plus-Enter chunk coalesced by a multiplexer stays keystrokes (Codex has the same residual risk window; it needs 3 fast chars before suppression too).
- Chunks without embedded control characters (single-line pastes, plain typing, `hello 世界` style batches) remain per-character keystroke events.

## Alternatives considered

- Port Codex's timing heuristic into `Editor.handleInput` (8 ms inter-char interval, 3-char minimum, 120 ms Enter-suppression window): rejected — it classifies any three synchronously delivered characters as a paste, which is exactly how every editor test types, so either the heuristic breaks the test suite or every typing test must sprinkle sleeps; it also loses `handlePaste` semantics (markers, normalization, undo atomicity) because the text is inserted character by character.
- Same timing heuristic inside `StdinBuffer`: rejected — same synchronous-feed misclassification against its existing tests, plus retro-capture of the first two characters is impossible there (they are already emitted).
- Hold the first printable character ~10 ms (Codex's flicker suppression): rejected — adds latency to every keystroke at a layer below the editor and still needs timers in tests.
- Chunk shape only at the `Terminal` layer: rejected — `StdinBuffer` is where chunk boundaries are still visible before sequence splitting; `Terminal` only sees the split stream.

## Consequences

- Benefit: markdown pastes survive intact on terminals without bracketed paste; detection is deterministic (no timing flakiness) and reuses the well-tested paste pipeline.
- Cost: a non-bracketed paste split so its first chunk has fewer than three printable characters before a CR still submits (Codex parity); per-chunk large-paste collapsing means a huge paste delivered as many small chunks may never form a single `[paste #N]` marker; Windows consoles that deliver pastes as per-character events are not covered (Windows Terminal supports bracketed paste; legacy conhost remains exposed).
- Testing: chunk classification in `packages/tui/test/stdin-buffer.test.ts` (`StdinBuffer paste-like chunks`); end-to-end flow (no submit, newlines preserved, CRLF normalized) verified against `Terminal`'s re-wrapping with a scripted StdinBuffer-to-Editor harness.

Related: [editor-placeholder-ghost-suggestion-paste-viewport](../feature/2026-10-12-editor-placeholder-ghost-suggestion-paste-viewport.md) (paste viewport and threshold this builds on).
