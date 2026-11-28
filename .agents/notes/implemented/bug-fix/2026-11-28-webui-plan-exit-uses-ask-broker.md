# Agent Note: WebUI plan exit prompt uses the ask broker

Status: implemented

## Problem

The `/plan` exit confirmation was only reachable in the TUI. `agent_settled`
checked `ctx.hasUI` before calling `ctx.ui.select()`, but a webui session binds
no UI context, so the card never appeared. The user could leave plan mode only
by switching modes manually in the settings panel.

## Decision

When the settled session is in webui mode, the exit prompt is published through
`extraBridge.asks` as a single-choice question with `custom: false`. The two
options reuse the TUI labels so a plan approved through either frontend sends
the same follow-up message. Approval calls `engine.setMode("standard", "plan
approved")` and submits `PLAN_APPROVED_MESSAGE`; declining or skipping keeps
the mode unchanged and notifies the user to type a revision.

`session_shutdown` now cancels outstanding asks alongside permission prompts,
so a pending exit card cannot linger after the session ends.

## Alternatives considered

- **Give webui sessions a UI context implementing `ctx.ui.select`.** The
  question tool already had the same gap and was routed through `AskBroker`
  instead; duplicating the dialog bridge for one more prompt would render the
  same card through two paths.
- **Leave the settings-panel mode switch as the only exit.** It bypasses the
  plan's verification step and sends no approval message, so the agent is left
  with a plan in the transcript and no instruction to execute it.

## Consequences

- Webui receives the exit card through the existing `user_input_request` SSE and
  `/chat/user-input` endpoint; no new wire format or frontend component is
  needed.
- The answer is advisory to the currently running turn: the shared broker is
  process-wide and matches by request id, so a card seen through `/chat/active`
  can still be answered.
- `/chat/user-input` with `responses` batches is accepted but not produced by
  this single-question prompt; only the first answer is read.
- Regression coverage: `packages/extra/test/webui-mode-wiring.test.ts` captures
  the published question and exercises approval and decline through the real
  broker, with `agent_settled` driven by the extension factory.

## Testing

- `pnpm exec vitest --run test/webui-mode-wiring.test.ts` from `packages/extra`.
