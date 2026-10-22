# Agent Note: Mirror the todo plan into the webui

Status: implemented

## Problem

Issue #152 asked whether the webui supports tool calls, questions and step
creation. Tool calls and questions do: `tool_start`/`tool_output`/
`tool_result` fold into a process group, and `ask_user_question` reaches the
browser as `user_input_request`. Steps did not exist on screen.

`todo-lite` is a bundled extra that runs in every mode, and the plan lives in
the tool's `details.todos`. The TUI reads it back from the `tool_result` event
(`extras/pi-ui/src/working.ts` renders `<done>/<total> <current step>` in the
Working line). The webui had no equivalent: `webui-server.ts` flattened
`tool_execution_end` into text

    content → join(text parts) → { type: "tool_result", output }

and dropped `details` entirely, so the plan was built, updated and reasoned
about by the model while the browser showed only `已运行 1 条命令`. The
transcript is SSE-pushed, so no frontend-only change could recover a plan the
backend never sent.

## Decision

The plan travels as an optional field on the existing `tool_result` event, and
the frontend renders it as its own dock capsule.

Backend (`packages/coding-agent/src/modes/webui/webui-server.ts`):
`planSnapshotOf(toolName, details)` returns `{ plan }` for `todo` and `{}` for
everything else, so a non-plan tool call grows no field. The snapshot is the
whole list, not a delta: `todo` results are self-describing (`list`/`add`/
`update`/`delete`/`clear` all return the post-action list), which means a
missed event cannot desync the display the way a delta would. Rows are
normalized (id must be a number, status must be one of the four, text must be
a string) and a malformed row is dropped rather than poisoning the list. A
`clear` sends `plan: []`, which is what removes the card.

Frontend: `use-chat.ts` keeps `plan` in hook state and replaces it on every
`tool_result` carrying `plan`. It resets on `loadSession` and `newSession`,
because the plan belongs to the session, not to the render. `components/
plan-card.tsx` sits in the composer dock above `PermissionCard`/`UserInputCard`
with the same `max-w-[840px]` gutters: `N/total 步骤` header plus the current
step's text, one row per item (`completed` muted with a check, `in_progress`
with a spinner, `cancelled` struck through, pending as a dot, verification
steps labelled). A plan with nothing open collapses to the header row with a
toggle, so a finished plan does not hold the composer down; the next
`tool_result` that reopens work expands it again.

Localization follows the existing `t()` table (`步骤`, `验证`, `展开步骤`,
`收起步骤`).

## Alternatives considered

- **Render the plan in the transcript instead of the dock.** The todo tool
  runs several times per turn, so a transcript block would either duplicate
  per call or need to mutate an earlier message. The dock also matches where
  the TUI puts the same information (the working line above the editor), and
  it keeps the plan visible while the user scrolls up.
- **Derive the plan in the frontend from the `todo` tool's JSON args.**
  `add`/`update`/`delete`/`clear` would each need replaying against a local
  model, including the batch and single shapes and the cancelled/verification
  invariants. Reading the authoritative post-action list costs one field on
  the wire and no duplicated rules.
- **Reuse the RPC `__gui__` tree the tool already builds for GUI mode.** That
  shape (`list-tree` / `TreeItem`, only populated when `ctx.mode === "rpc"`)
  is a rendering protocol for another consumer; mapping it back into React
  components would couple the browser to it for less information (no
  verification flag, no ids).
- **Keep the plan in `pi-ui`'s module state and expose it over a new SSE
  event.** `pi-ui` is a TUI module (`ctx.mode !== "tui"` returns early) and
  the webui server has no channel into it; the tool result is already the
  shared, mode-independent source of truth (issue #152's own analysis pointed
  at `tool_result.details.todos`).

## Consequences

- The plan is visible in the browser while it is being executed, which is what
  makes step creation on the webui usable at all.
- The plan is a snapshot of the last `todo` result, so a transcript reloaded
  from disk shows no plan until the next `todo` call. Rebuilding it from the
  session history was out of scope: `/projects/:hash/sessions/:id` does not
  carry tool `details`, so the endpoint would have to re-derive them from the
  message log.
- Two shapes now describe a plan (`details.todos` in the tool, `plan` on the
  wire). They are deliberately similar but separately typed, so the browser
  does not import the extension's module types; the initializer in
  `planSnapshotOf` is the single place the mapping is written.
- Testing: `test/webui-plan-snapshot.test.ts` covers mirroring, the `clear`
  snapshot, non-plan tools, and malformed rows. `pnpm run check` covers types
  and the browser smoke check; the card was verified visually against a live
  webui session.
