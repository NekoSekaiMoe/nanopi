# Agent Note: Plan mode can ask questions, and the WebUI can answer them

Status: implemented

## Problem

`ask_user_question` (ask-lite) was unreachable in the two situations where a
question matters most.

**Plan mode blocked it.** The plan-mode gate allowed `read`, `ls`, `find`, and
`pwd`, and blocked everything else. The questionnaire is neither a read nor a
mutation, so a plan-mode run could discover an ambiguity, hold the guideline
"Investigate, then produce a concrete step-by-step plan", and have no way to
resolve it -- the model either guessed or produced a plan with the open question
buried in it. That is the failure plan mode exists to prevent.

**The WebUI could not render it.** The tool draws itself through
`ctx.ui.custom()`, and a `nanopi webui` session binds no UIContext (the registry
substitutes `noOpUIContext`, and `hasUI()` reports false), so every call
returned `"Error: UI not available"`. The WebUI already had the other half: a
`UserInputCard` component, `POST /chat/user-input` on the client, and a
`user_input_request` SSE case in `Chat.tsx`. Only the daemon side was missing --
`/chat/user-input` answered `{ accepted: false, error: "not supported" }` and no
event was ever emitted, so the card could never appear.

## Decision

- Plan mode allows `ask_user_question` beside `read` and the read-only shell
  commands. The plan-mode guideline names it, so the model knows the option
  exists. The whitelist moved out of the `tool_call` handler into the exported
  pure `planModeVerdict(toolName, input)`, because it is the whole safety
  boundary of plan mode and previously could only be tested through a session.
- `AskBroker` (packages/extra) is the structured-input counterpart of
  `PermissionBroker`: one outstanding questionnaire, answered by request id,
  `cancelAll()` on session shutdown, exposed as `extraBridge.asks`.
- The ask-lite tool falls back to that broker when `ctx.ui.custom` is
  unavailable, mapping the WebUI's flat `selected`/`text` answer back onto its
  own `QuestionAnswer` contract. It returns its existing no-UI error when the
  broker is absent (build flavors without the extra module), so a stubbed build
  degrades exactly as before.
- The WebUI server publishes the questionnaire as `user_input_request` with the
  flat fields mirroring `questions[0]` (so a single question needs no batch
  protocol) and sends `questions` when there is more than one. `POST
  /chat/user-input` resolves the broker, accepting either a single answer or a
  `responses` array.

## Alternatives considered

**Let the WebUI implement `ctx.ui.custom` and render the tool's own TUI
component.** The TUI questionnaire is a key-driven terminal widget; the WebUI
already ships a purpose-built Preact card for this exact payload, so
implementing `custom` would mean reimplementing a worse card behind a much
larger interface.

**Teach `ask-lite` about the WebUI directly.** It cannot: the WebUI server is in
`packages/coding-agent` and the tool is a compiled-in extra, and a direct import
would invert the dependency. The bridge is the established seam for every other
WebUI-to-extension interaction.

**Treat the questionnaire as a mutation and keep blocking it in plan mode.**
Then plan mode cannot gather requirements, which makes its read-only guarantee
buy much less than it costs.

## Consequences

- Plan mode can resolve ambiguity, and its guideline tells the model to. The
  gate's read-only guarantee is unchanged: `planModeVerdict` still blocks every
  mutating tool, and answering a question changes nothing on disk.
- `nanopi webui` gains working structured input in the composer seat it already
  reserved, including the multi-question stepper the card implements.
- Print, RPC, and other dialog-less modes now block on the broker rather than
  failing instantly. A session with no WebUI subscription behind the bridge has
  nothing to answer it, so a question there waits until the session aborts
  instead of returning an error immediately. The tool must not silently answer
  on the user's behalf, and inventing a different timeout per mode would make
  the failure mode depend on which frontend is attached.
- `mode: "text"` questions are supported end to end, but the card's text area is
  reachable only for a question with no options; a question with options renders
  the option rows plus the "type your own answer" row.

## Testing

- `packages/extra/test/plan-mode-policy.test.ts` pins the whitelist: `read` and
  `ask_user_question` allowed, only `ls`/`find`/`pwd` through the shell, every
  mutating tool blocked, and a shell call without a command string blocked
  rather than allowed.
- `packages/extra/test/ask-broker.test.ts` covers prompt publication, answer
  correlation by request id, one-prompt-at-a-time serialization, the empty
  questionnaire, and `cancelAll()`.
- End-to-end: the extra module's real `tool_call` handler under plan mode
  reports `ask_user_question` allowed and `edit` blocked; the bridge round-trips
  a question and answer; and the WebUI server's SSE and endpoint paths are
  exercised through the same handlers the frontend uses.
