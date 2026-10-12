# Agent Note: Input-box placeholder, ghost next-prompt suggestions, and Codex-style paste viewport

Status: implemented

## Problem

Three gaps between the interactive input box and the Codex reference:

1. The empty composer showed nothing — Codex renders a dim placeholder ("Ask Codex to do anything").
2. After an assistant reply the user got no hint what to ask next; Claude-Code-style next-prompt suggestions did not exist.
3. Pasting a markdown document collapsed into `[paste #N +N lines]` whenever it exceeded 10 lines, so most pasted docs were never visible in the editor (felt like truncation). Codex collapses only above 1000 characters and keeps shorter multi-line pastes verbatim, with `↑`/`↓` markers for hidden rows.

## Decision

- **Placeholder** (pi-tui `Editor`): `placeholder` option + `setPlaceholder()`, rendered dim while the editor is empty via optional `EditorTheme.placeholderStyle` (default ANSI dim; coding-agent maps it to the `muted` theme token).
- **Ghost suggestion** (pi-tui `Editor`): `setGhostSuggestion()` renders a dim suggestion while the editor is empty. The existing `tui.editor.cursorRight` action accepts it when the cursor sits at the end of the text (fish-style forward-char accept); any other input dismisses it permanently — it never comes back for the same turn. It is render-only: `getText()`/`getExpandedText()`/submission never see it. `setText()`/`insertTextAtCursor()` clear it (programmatic text invalidates it).
- **Suggestion generation** (coding-agent): `AgentSession.generateNextPromptSuggestion()` runs after `agent_settled` (not aborted). It serializes the last 24 LLM messages with the compaction `serializeConversation` helper into one user message — text flattening avoids orphaned toolCall/toolResult pairs a blind message slice would produce — and calls `completeSummarization` with the session `streamFunction` (single attempt, no retry; failures just skip the ghost text). Sanitizer collapses to one line, strips wrapping quotes/backticks, caps at 120 chars. Gated by the `nextPromptSuggestions` setting (default on; `/settings` toggle). `InteractiveMode` guards: setting on, not streaming, default editor focused, editor empty; `agent_start`/rebind/shutdown abort in-flight requests and clear the ghost.
- **Paste viewport**: large-paste collapse is now character-only (>1000 chars, `LARGE_PASTE_CHAR_THRESHOLD`, matching Codex), marker text always the `N chars` form (the `+N lines` form stays parseable for history). Visible-line cap moved from 30% to 20% of terminal rows (min 5); pastes land with the cursor at the end so the viewport shows the last lines. Hidden-line counts render as one combined `↑ N · ↓ M` label above the composer (user preference: both numbers in one place, bottom row plain).

## Alternatives considered

- Separate `tui.editor.acceptSuggestion` keybinding defaulting to `right`: rejected — it would double-bind the right arrow against `tui.editor.cursorRight` and need conflict resolution in the keybinding UI; piggybacking on the existing configurable action keeps AGENTS.md's "no hardcoded key checks" rule without a duplicate binding.
- Slice raw LLM messages for the suggestion context: rejected — a slice can orphan tool calls/results, which some providers reject; the text-serialized transcript is provider-proof and cheap.
- Retry suggestions with the configured retry policy (like branch summaries): rejected — suggestions are opportunistic UI sugar; silent single-attempt keeps failure cost at one request and avoids retry storms when auth is broken.
- Never collapse pastes (always full text): rejected — a 10k-line paste in the editor makes every keystroke re-layout thousands of wrapped lines; the marker keeps the buffer small while `getExpandedText()`/submission preserve the full content (Codex's anti-truncation approach: bracketed paste + full-text registry + expand-on-submit).
- Codex's blockquote continuation (paste into `> ` prefixes every line): rejected for now — nanopi has no markdown-quoting convention in its input box; nothing to continue.

## Consequences

- Benefit: Codex-parity composer affordances; pasted markdown docs stay visible and scrollable; suggestions cost one small non-retrying request per turn and can be turned off.
- Cost: every assistant reply triggers one extra model call by default (bounded: 6000 transcript chars, 256 max output tokens, no retry, abortable); extension editors must opt into `setGhostSuggestion`/`setPlaceholder` via `EditorComponent` to participate; `renderTopBorder(width, hiddenAbove, hiddenBelow)` signature change means subclasses must update (only `CustomEditor` in-tree).
- The suggestion request runs on the session's stream function, so providers see one non-cached side-channel call per turn (`cacheRetention: "none"`); faux-provider tests script it as an extra response step.
- Testing: placeholder/ghost render, accept, dismissal, and paste viewport in `packages/tui/test/editor.test.ts`; suggestion generation/sanitizing/abort in `packages/coding-agent/test/suite/agent-session-next-prompt-suggestion.test.ts`.

Related: [codex-composer-editor-and-quit-reminder](2026-10-11-codex-composer-editor-and-quit-reminder.md) (composer layout this builds on), [shell-mode-composer-affordances](2026-10-11-shell-mode-composer-affordances.md).
