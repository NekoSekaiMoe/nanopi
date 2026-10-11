# Agent Note: Codex-style composer editor and the Ctrl+C quit reminder

Status: implemented

## Problem

The input box looked nothing like the Codex reference the user wants:
nanopi drew horizontal rules above and below the text (colored by thinking
level) while Codex renders a bare composer — blank padding rows, a bold `› `
prompt glyph before the first line, continuation lines aligned under it, and
no border. Separately, double Ctrl+C already quit (500 ms window) but showed
no hint, so the exit path was undiscoverable; Codex has a
`{key} again to quit` footer reminder with a 1 s timeout.

## Decision

- `Editor` (pi-tui) gains `style: "bordered" | "composer"` (default
  `bordered`) and a `prompt` option (default `"› "`), plus a public
  `setPrompt()`. In composer style the top/bottom rows are blank padding
  (the working status and right-aligned scroll indicators render into them),
  the first visible line is prefixed with `this.borderColor(prompt)`, and
  continuation lines are indented by the prefix width; `contentWidth` and
  mouse hit-testing account for the prefix. `EditorComponent` exposes
  optional `setPrompt` so extension editors can participate.
- `CustomEditor` (coding-agent) constructs the default editor with
  `style: "composer"`; `updateEditorBorderColor` also swaps the prompt
  (`› ` normally; `$ ` in bash mode since
  [shell-mode-composer-affordances](2026-10-11-shell-mode-composer-affordances.md)),
  so the existing thinking-level color (which used to tint the border rules)
  now colors the prompt glyph. The embedded working status renders left-aligned on the blank top row with the
  scroll indicator right-aligned (dashes only ever existed in bordered
  style).
- Ctrl+C: the quit window widens from 500 ms to 1 s
  (`InteractiveMode.QUIT_REMINDER_MS`, matching Codex's
  `QUIT_SHORTCUT_TIMEOUT`). The first press clears the editor and replaces
  the footer with a dim `{Ctrl+C} again to quit` line via
  `FooterComponent.setTransientLine` (key label from the `app.clear`
  binding); a timer restores the footer after the window. The second press
  inside the window quits.

## Alternatives considered

- Restyle with bordered rules kept (thinner/dimmer): rejected — the user
  compared against Codex's borderless composer directly; rules of any weight
  are the divergence.
- Follow Codex fully and disable double-press quit
  (`DOUBLE_PRESS_QUIT_SHORTCUT_ENABLED = false` upstream, they found double
  press janky): rejected — nanopi already had double-press Ctrl+C; the gap
  was discoverability, which the reminder fixes without changing when the
  app exits.
- Put the quit reminder in the chat as a `showStatus` line: rejected — it
  pollutes the transcript with a transient hint; the footer row is where
  Codex renders it and nanopi's footer is otherwise idle.

## Consequences

- Benefit: the input area matches the Codex reference; the thinking-level
  indication survives as the prompt color; quitting is discoverable.
- Cost: the editor border color no longer spans the width (only the `›`/`$`
  glyph carries it), and extension editors that do not pass
  `style: "composer"` keep the bordered look by default. Shell mode no
  longer recolors the prompt; see
  [shell-mode-composer-affordances](2026-10-11-shell-mode-composer-affordances.md).
- Testing: composer prefix/indent/padding/scroll rows are covered in
  `packages/tui/test/editor.test.ts`; the quit reminder lifecycle (reminder
  text, expiry, second-press quit) in
  `test/interactive-tui.test.ts`.
