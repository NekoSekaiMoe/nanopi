# Agent Note: Silent re-issue when a relay substitutes the model

Status: implemented

## Problem

A relay or aggregator can answer a request with a model other than the one
selected. In nanopi nothing noticed:

- Every adapter already calls `options.onResponse({ status, headers }, model)`
  (`packages/ai/src/api/*.ts`), but `createAgentSession` never passed
  `onResponse` into `new Agent({...})`, so `agent.onResponse` stayed undefined
  and the headers were dropped. Only `onPayload` was wired (`sdk.ts`).
- The Gemini adapters (`google-generative-ai`, `google-vertex`, and
  `antigravity`, which reuses them) never called `onResponse` at all. The
  `@google/genai` SDK exposes no response object, so there was no headers to
  report even for a caller that asked.
- `AssistantMessage.responseModel` already carries the model the provider
  reports in the *body* (Anthropic sets it from `message.model`), but a body
  field only arrives after the tokens are paid for.

The user's requirement was explicit: the check must be silent. No footer
marker, no notification, no error — just put the request back on the selected
model.

## Decision

The check lives in `AgentSession` and is invisible by construction.

**Detection** (`core/model-identity.ts`): `readEchoedModel(headers)` reads the
first present of `openai-model`, `x-model`, `x-actual-model`, `x-model-id`,
`x-served-model`, `x-upstream-model`, `x-llm-model`, `x-model-name`,
`azure-openai-model`, `x-goog-model`, `x-amzn-bedrock-model-id`,
case-insensitively. `modelsMatch` compares the **last path segment** after
dropping a `:variant`/`@variant` suffix and a `-YYYY-MM-DD` /
`-YYYYMMDD` suffix, so `openai/gpt-5.3-codex` vs `gpt-5.3-codex`, or
`claude-opus-4-5` vs `claude-opus-4-5-20251101`, are not substitutions. A
shared prefix is not enough: `gpt-5` vs `gpt-5-mini` does mismatch.

**Recording**: `_installModelIdentityCheck` wraps `agent.onResponse`, compares
the echo with the requested `model.id`, skips virtual selections (a routed
selector is not a substitution), and stores
`{ requested, observed, leafId, reinjected }`. `leafId` is
`sessionManager.getLeafId()` at hook time — the leaf before the response is
appended.

**Re-issue**: `_shouldReissueOnRequestedModel` grants one per user turn
(`MAX_MODEL_REISSUES_PER_TURN`, reset on `agent_start`). The claim happens in
`agent.finishTurn`, which returns `{ action: "continue" }` so the loop issues
one more request; `_dropSubstitutedResponse` then rewinds the branch to
`leafId` with `sessionManager.branch()` and `_refreshFinalizedContext()`, so the
substituted answer leaves the active branch and is never part of the
transcript the parent turn sees. The session is append-only, so the re-issued
turn is written as a sibling — nothing is deleted from disk.

A second mismatch does nothing: the endpoint cannot serve the selected model,
and retrying again would loop.

**Gemini headers**: `google-shared-stream.ts` reports the first chunk that
carries `sdkHttpResponse`, once, and copies `modelVersion` into
`responseModel`. A chunk with no `sdkHttpResponse` reports nothing rather than
inventing a `200 {}`.

## Where the re-issue had to live

Three placements were tried; only the last works, and the failure modes are
worth recording because the agent loop constrains all of them.

1. `prepareRequest` dropping the message and re-asking — no. `prepareRequest`
   runs once per conversational request, and the loop only asks for another
   request when `finishTurn` says `continue` or tool calls remain. A plain
   assistant turn ends the run.
2. `prepareNextTurnWithContext` clearing `agent.state.messages` and returning
   a model — no. `prepareNextTurn` does not run at all before the first
   request of a turn, and the loop has already read `config.model` by then.
3. `finishTurn` returning `{ action: "continue" }` — yes. It is the only hook
   whose return value makes the loop request again.

Two ordering facts cost the most time and are easy to re-learn the hard way:
`agent_start` fires *after* the first `onResponse` of the run (so clearing the
mismatch there is safe only because `finishTurn` has not claimed it yet), and
the assistant message is persisted on `message_end`, which runs *before*
`finishTurn`. That is why the rewind is a branch move rather than a
never-persist.

## Alternatives considered

- Surface a footer marker plus a `/codex-downgrade`-style command, as
  `pi-packages`' downgrade detector does. Rejected: the user asked for silence,
  and the evidence is not worth a permanent UI slot for a case that is either
  transient (a re-issue fixes it) or unfixable (the endpoint will keep
  substituting).
- Compare against `AssistantMessage.responseModel` instead of headers.
  Rejected: that field is only known after the body is paid for, and most
  adapters do not set it.
- Re-issue indefinitely until the echo matches. Rejected: a hard substitution
  would loop forever at the user's expense.
- Treat the mismatch as an error. Rejected: a substituted answer is usually
  usable, and failing the turn costs the user the work.

## Consequences

The substitution costs one extra round trip and nothing else: the mismatched
answer is rewound off the active branch, so the parent turn never reads it,
and the session file keeps it as a sibling the user can still scroll back to.
A silent check has no UI surface to explain itself, so the only evidence of a
substitution is the `reinjected` flag on the recorded observation.

Cost: every response now pays one header read and a string comparison per
request, and `AgentSession` grows four pieces of state (`leafId` bookkeeping,
the per-turn re-issue claim, the recorded observation, and the `onResponse`
wrapper that must survive session reloads). A relay that substitutes on every
request also pays one wasted request per turn, because the second mismatch
deliberately stops.

Verification: `packages/coding-agent/test/model-identity.test.ts` pins the
header list and the `modelsMatch` cases (path-prefix, `:variant` suffix,
`-YYYY-MM-DD` suffix, and that `gpt-5` vs `gpt-5-mini` is a mismatch);
`packages/coding-agent/test/model-identity-reissue.test.ts` drives a faux
provider through `createAgentSession` and asserts exactly one re-issue per
turn, that the substituted answer is not on the branch the parent sees, and
that a second mismatch ends the turn instead of looping.
