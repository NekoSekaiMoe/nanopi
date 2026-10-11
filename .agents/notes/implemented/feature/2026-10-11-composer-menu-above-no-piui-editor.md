# Agent Note: pi-ui ships no editor; the core composer draws the menu above

Status: implemented

## Problem

Two successive wrong turns on where "menu above" and "gradient" live:

1. The user's ask — "pi-ui 的更改（/命令改为向上，loop 中为渐变）怎么没有生效" —
   named the slash menu opening upward and the gradient in the Working loop
   (the shimmer), not the input frame.
2. Restoring the pre-`0d669b591` pi-ui editor brought the framed input
   (gradient rules, accent gutters, embedded model toolbar) back with it,
   which the user never asked for: "你怎么把 pi ui 的输入框也给恢复了，你把这个
   删了就行".

## Decision

- pi-ui installs no editor: `editor.ts` is deleted and `setEditorComponent`
  is unwired. `footer.ts`'s factory is now the one place pi-ui receives the
  TUI, so `captureRenderTrigger` (used by thinking.ts repaints) moved there.
- The default composer owns the input surface. `Editor` in pi-tui gains
  `autocompleteDirection: "below" | "above"` (default below): "above" emits
  the autocomplete rows before the top border and remaps mouse rows onto the
  base geometry so menu clicks and cursor placement keep working. The
  interactive mode's editor sets `"above"`.
- The Working-line gradient (shimmer) and the `Worked for Ns` elapsed row
  stay in pi-ui's `working.ts`, untouched by the editor changes.

Supersedes
[pi-ui-gradient-editor-menu-above](./2026-10-11-pi-ui-gradient-editor-menu-above.md)
(same day): the menu direction survives, the restored editor frame does not.

## Alternatives considered

- Keep the pi-ui editor without the frame rules: rejected — the frame, the
  gutters, and the toolbar are one layout; stripping them recreates the
  default composer inside an extension for no benefit.
- Leave the menu direction to pi-ui and keep the default composer plain:
  rejected — the user asked for the upward menu in the core look, and the
  base `Editor` is the only place that can serve every editor style.

## Consequences

- Benefit: one input surface (the core composer) with a first-class
  direction option; pi-ui shrinks to what its name says — a reskin of rows,
  footer, and working line, not an editor.
- Cost: extension editors created via `ctx.ui.setEditorComponent` default to
  the below menu; they must pass `autocompleteDirection: "above"` themselves.
  `renderedAutocompleteHeight` bookkeeping is shared by render and
  hit-testing, so geometry changes must update both (covered by
  `test/editor.test.ts`).
