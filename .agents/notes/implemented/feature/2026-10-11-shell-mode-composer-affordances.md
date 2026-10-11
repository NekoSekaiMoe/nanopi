# Agent Note: Shell mode affordances — `$` prompt, hidden bang, footer label

Status: implemented

## Problem

The borderless composer ([2026-10-11-codex-composer-editor-and-quit-reminder](2026-10-11-codex-composer-editor-and-quit-reminder.md)) swapped the prompt glyph to `! ` in shell mode and colored it with the `bashMode` theme token (green). Typing `!ls` therefore rendered `! !ls`: the prompt `!` plus the typed `!` still present in the text. The green glyph also recolored the composer chrome, so the input area was green instead of gray, and there was no yellow shell accent anywhere — the user's reference is Codex, whose composer keeps a neutral box, colors the shell sigil (and its `Shell mode` footer label) in one accent color, and never shows the typed `!` twice.

Codex specifics this follows (codex-rs `bottom_pane/chat_composer.rs`): the leading `!` is absorbed into prompt state (`imported_text_for_textarea`) so the textarea never contains it; the prompt renders `Span::from("!").light_red().bold()`; and `shell_mode_footer_line()` right-aligns a `Shell mode` label in the same color on the footer.

## Decision

Shell mode is shown by three coordinated affordances instead of a recolored prompt:

- The prompt glyph becomes `$` (user preference over Codex's `!` glyph); the composer chrome keeps following the thinking level, so with thinking off the input area stays gray in every mode.
- `Editor.setShellMode(true)` (pi-tui, composer style only) hides the leading `!` — including an indented one preceded only by spaces — from the first rendered line after layout, shifting `cursorPos` to match the shorter display. The editor text is untouched: submission (`text.slice(1)`), history, and autocomplete still see `!command`.
- `FooterComponent.setShellMode(true)` right-aligns a yellow `shell` label on the footer line; when the width cannot fit label plus usage line, the usage line truncates and the label wins (Codex lets the status truncate too).

The `bashMode` theme token is repurposed from "editor border color in bash mode" (green, okhsl 159) to the shell accent color (palette `yellow` in dark/light/system themes) and now colors the footer `shell` label; the bash tool rows in the transcript keep using it, so all shell-related accents are one yellow. `Theme.getBashModeBorderColor()` is removed with the editor-side use.

`updateEditorBorderColor` (coding-agent) drives all three affordances from one place: thinking-level border color, `$ `/`› ` prompt, `setShellMode`, and the footer label.

## Alternatives considered

- Keep the `!` prompt glyph and just hide the typed bang (minimal fix): rejected — the user explicitly preferred `$` as the shell-mode glyph plus the corner label, which also matches Codex's "label in the footer" pattern more closely than a yellow bang would.
- Absorb the `!` into editor state Codex-style (textarea never contains it): rejected for now — it touches text state, history, submission, and autocomplete offsets across pi-tui and coding-agent; the display-level strip achieves the same user-visible result with a localized change. pi-ui's `hideLeadingShellBang` proves the display-level approach.
- Color the `$` prompt yellow as the shell accent: rejected — the yellow accent lives in the footer label (and transcript rows); keeping the prompt on the thinking-level color preserves the composer's "chrome follows thinking" rule from the composer note.

## Consequences

- Benefit: single `$` sigil, gray composer in all modes, one yellow shell accent shared by the footer label and bash tool rows; submission semantics unchanged.
- Cost: the strip is display-only, so a wrapped first line lays out as if the `!` were still present (one column narrower than it could be) — cosmetic, same tradeoff pi-ui ships. Extension editors in bordered style (pi-ui) are unaffected because the strip is guarded to composer style, keeping pi-ui's own bang hiding from double-stripping.
- Testing: `packages/tui/test/editor.test.ts` covers bang hiding (leading, indented, non-composer, shell-mode-off, text intact); `packages/coding-agent/test/footer-width.test.ts` covers the right-aligned label, narrow-width fit, and off-state.
