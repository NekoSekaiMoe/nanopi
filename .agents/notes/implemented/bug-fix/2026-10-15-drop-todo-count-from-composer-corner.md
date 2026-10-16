# Agent Note: Drop the todo count from the composer corner

Status: implemented

## Problem

The user reported "把输入框右下角的 0/x（在有 steps 出现）给去掉".

The count came from two producers of the same number:

1. `renderWidgetLines` (todo-lite) pushed a `☑ 0/9` header row as the first
   line of the `todo` extension widget. With pi-ui active, the widget write is
   suppressed, but the plan itself still surfaces in the composer area.
2. `renderStatusText` (todo-lite) pushed the same `☑ 0/9` text through
   `ctx.ui.setStatus("todo", …)`, which pi-ui's footer renders right-aligned
   at the bottom-right of the composer line. `handlers.ts` additionally
   overwrote it with `📋 N pending` before each agent turn.

Both numbers are already visible elsewhere: pi-ui's Working line carries
`<done>/<total> <current step>` while a plan is being executed, and `/todos`
shows `N/M completed` in its own dialog. The composer corner was a third copy
of data that changes on every single todo update, and it is the one place
where it is noise — the corner is where the `shell` label and mode badges
compete for width.

## Decision

Remove the count from both producers; keep a presence indicator:

- `renderWidgetLines` no longer emits the `☑ N/M` header row. The widget now
  starts directly with the plan items (single column up to 8, dual column
  above that, same as before).
- `renderStatusText` degrades to a bare glyph: `☑` (accent) while any todo is
  open, `✓` (success) when all are completed. It still returns `""` for an
  empty list so `setStatus("todo", undefined)` clears the slot as before.
- `handlers.ts`'s `📋 N pending` override is left alone — it is transient,
  only set while a turn is starting, and is not a persistent corner fixture.

`WIDGET_MAX_LINES` / `SINGLE_COLUMN_BUDGET` math is unchanged: those budgets
already accounted for the header row being present, so dropping it only ever
frees a line, never truncates a plan item.

## Alternatives considered

- Suppress the `todo` status key in pi-ui's footer instead (skip the
  `"todo"` entry when joining status parts): rejected — it hides one module's
  data based on its key inside another module. Any other module that wants a
  corner count would still be noisy, and todo-lite would keep producing a
  string nobody renders.
- Keep the widget header but move it to the `/todos` dialog only: the widget
  is already suppressed under pi-ui; the fix is at the producer, not at one
  consumer.
- Show the count only when a plan is incomplete (drop the `0/9` at plan
  creation): rejected — the user asked for the counter to be gone, and
  "sometimes a number in the corner" is the same problem with a narrower
  trigger.

## Consequences

- Benefit: the composer corner carries only mode/state badges that the user
  acts on (shell, yolo/plan, rewind checkpoints); progress lives in the
  Working line and `/todos`, each of which already owned it.
- Cost: the widget's first row no longer summarizes the plan, so a plan read
  in isolation (e.g. an RPC consumer that renders the raw widget lines) loses
  the totals. RPC has no composer and gets no corner either, so the only
  consumer that could notice is a future one.
- Testing: `packages/coding-agent/src/extras/todo-lite/src/__tests__/todo.test.ts`
  asserts the header row is gone (`lines.length` drops by one at every size,
  and the 9-task case asserts `0/9` no longer appears).

Superseded: this note kept a bare presence glyph in the corner; issue #17 showed
the glyph itself was the complaint. See
[2026-10-16-todo-writes-nothing-to-the-corner](2026-10-16-todo-writes-nothing-to-the-corner.md).

Related: [footer badges through the status channel](2026-10-13-footer-badges-status-channel.md)
(the channel that rendered the corner text),
[codex welcome, footer, /status](../feature/2026-10-11-codex-welcome-footer-status.md)
(the single-line footer the corner sits on).
