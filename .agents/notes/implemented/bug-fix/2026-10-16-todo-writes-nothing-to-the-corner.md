# Agent Note: Todo writes nothing to the composer corner

Status: implemented

## Problem

Issue #17 asked again for the bottom-right corner of the input box to be
cleared of todo output ("去除对话框右下角的 ☑ 和 4 pending以及 emoji").

The previous fix (`2026-10-15-drop-todo-count-from-composer-corner`) removed
only the numbers. Two producers of that same corner slot were left in place,
so the badge stayed — it just stopped changing numerically:

1. `render.ts` exported `renderStatusText`, which after that fix returned a
   bare glyph: `☑` (accent) while any todo was open, `✓` (success) once all
   were completed, `""` for an empty list. `refreshDisplay` pushed it through
   `ctx.ui.setStatus("todo", …)` on every tool call and every session restore,
   so the glyph was a permanent fixture for as long as a plan existed.
2. `handlers.ts`'s `before_agent_start` wrote `📋 N pending` (emoji included)
   straight afterwards, once per turn, while any todo was open.

The two writes fought over one slot: the count appeared when a turn started,
the glyph came back on the next todo update. `setStatus("todo", …)` is exactly
the channel pi-ui's toolbar renders right-aligned in the composer corner
(`2026-10-13-footer-badges-status-channel`), and the corner is where `shell`
and the mode badges compete for width. Progress is already visible on pi-ui's
Working line and in `/todos`, so both writes are pure noise there.

## Decision

todo-lite stops writing the corner entirely, and clears it deliberately:

- `renderStatusText` is deleted; `render.ts` is widget + tool-result rendering
  only, and has no "status line" layer left.
- `refreshDisplay` writes `ctx.ui.setStatus("todo", undefined)` unconditionally.
- `before_agent_start` writes `ctx.ui.setStatus("todo", undefined)` before it
  builds its steer message.

`undefined` rather than "skip the call" is deliberate: `setStatus` is a setter
over a persistent per-key map, so a session restored while an older build had
left a glyph in the slot would keep rendering it. Clearing on every refresh and
every turn removes stale values that no current code produced. The `todo` key
is left registered (it just never holds text) — unregistering is not part of
the API.

Nothing else moves: the widget, the tool result, the Working line, and the
`/todos` dialog are untouched, and the `WIDGET_MAX_LINES` /
`SINGLE_COLUMN_BUDGET` math already accounted for a header row that no longer
exists (dropping it only ever frees a line).

## Alternatives considered

- Suppress the `todo` key in pi-ui's footer (skip `"todo"` when joining the
  status parts): rejected — one module would hide another module's data based
  on a key, and todo-lite would keep producing a string nobody renders.
- Keep a presence glyph because "a corner indicator is useful": rejected — the
  user asked for the corner to be clear, and the Working line already shows the
  current step while a plan runs.
- Leave `before_agent_start`'s `📋 N pending` alone because it is transient:
  rejected — it is transient on exactly the wrong schedule. It fires once per
  turn, which is when the corner is being looked at, and it is the write that
  put the `📋` emoji the issue names back on screen.
- Delete the emoji from `📋 N pending` and keep a plain count: rejected — that
  is the `N/M` counter the previous fix already removed, just re-armed.

## Consequences

- Benefit: the composer corner carries only what the user acts on (`shell`,
  mode badges); todo progress lives where it already was — the Working line and
  `/todos`.
- Cost: an RPC consumer that wants a corner summary has no todo status string
  to read; RPC has no composer corner either, and the tool's `details.todos`
  remains the machine-readable source.
- Testing: `src/extras/todo-lite/src/__tests__/tool-rpc.test.ts` gains C-1 and
  C-2, which drive the real factory entry (`src/index.ts`) and assert that
  every `setStatus("todo", …)` on the tool path and on the
  `before_agent_start` path is empty. Re-running with the pre-fix
  implementation restored fails both, so neither is vacuous.

Supersedes `2026-10-15-drop-todo-count-from-composer-corner`, which assumed
the glyph was an acceptable residue; that note's reasoning about the count
still holds, its conclusion about the corner does not.

Related: [footer badges through the status channel](2026-10-13-footer-badges-status-channel.md)
(the channel that renders the corner text).
