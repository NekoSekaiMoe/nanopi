# Agent Note: Built-in github-copilot/auto virtual model

Status: implemented

## Problem

GitHub Copilot Free and Student plans force Auto model selection: the account's
`/models` catalog no longer marks specific models as picker-enabled, and chat
requests naming a specific model directly fail with `400 model_not_supported`
(see upstream pi issue #6550 and github/orgs/community/discussions#189268).
nanopi filtered its Copilot catalog by the account's picker list, so Free users
logged into GitHub Copilot ended up with an empty Copilot model list and no way
to use their subscription.

The Auto flow cannot be modeled as a normal catalog entry: `auto` is not a model
id the chat endpoints accept. Clients must open a model session, ask Copilot's
router which model fits the prompt, and send the chat request for the chosen
model with that session's token (`Copilot-Session-Token` header).

## Decision

`github-copilot/auto` is a built-in virtual model (coding-agent
`src/core/copilot-auto.ts`), seeded in `ModelRuntime`'s constructor and listed
for every Copilot login regardless of the account's `availableModelIds`, because
`withVirtualModels` appends virtual models after the provider's
`filterModels` pass. Virtual models are nanopi's existing contract for exactly
this shape: the selection stays `auto`, each request routes to a physical
catalog model, and responses record the physical model, so usage cost,
compaction limits, overflow recovery, and session resume all follow the model
that actually answered.

The wire protocol lives in pi-ai
(`src/providers/github-copilot-auto.ts`): `fetchCopilotAutoSession` opens
`POST {base}/models/session` with body `{auto_mode: {model_hints: ["auto"]}}`;
`fetchCopilotAutoRouterDecision` posts the prompt facts to
`POST {base}/models/session/intent` and is advisory by design (1s timeout,
HTTP/parse failures resolve `undefined`, callers fall back to the session pool).
The chat request itself is sent by the normal provider path for the routed
model.

### Route lifecycle

- Eligible models = session `available_models` ∩ physical Copilot catalog,
  filtered to image-capable entries when the request carries images.
- The route is sticky: the state persisted on the session branch
  (`{modelId}`) is reused across continuations, compaction ("direct"), and new
  user turns while it stays eligible. A mid-conversation model switch would
  discard the prompt cache and provider continuity, so only a first selection,
  an invalidated selection, or a failed request re-consults the router.
- On retry the failed model id is excluded from the candidate order
  (router chosen → router candidates → session `selected_model` → first
  eligible).
- Auto sessions are cached in-process keyed by the Copilot access token (they
  die with it), refreshed 5 minutes before `expires_at`, single-flight, and the
  cache prunes expired entries past 8 tokens.

### Request-scoped route headers

The session token must reach the chat request but only that request. Routers
have no hook for this, so `ModelRoute` gained an optional `headers` field.
`resolveModel` passes it through, agent-session's `prepareRequest` returns it in
the `AgentRequestUpdate`, and the agent loop merges it into the stream options
of exactly the next request — a later update without `headers` resets them.
Compaction/summarization (`_getSummarizationRequestAuth`) merges the same
headers over resolved auth headers.

## Alternatives considered

- **Provider-level pseudo-model in pi-ai** (wrap the Copilot provider's
  `stream`/`streamSimple` and rewrite stream events back to `auto`, as the
  community extension `pi-copilot-auto` does for upstream pi): rejected because
  responses would record `auto` as the model, so cost, compaction limits, and
  overflow recovery would all consult a placeholder window (128k) or mutated
  shared catalog state. nanopi's virtual-model machinery already solves the
  identity problem; the only missing piece was header transport.
- **Global auto-session registry in pi-ai with provider-side token injection**
  keyed by session id: rejected because it hides routing state in module
  globals and would stamp the session token onto direct (non-Auto) model
  requests once any session used Auto.
- **Recommend the community extension instead of building it in**: rejected;
  Free-tier support is a product gap of this fork, and the extension's approach
  fights nanopi's virtual-model contract (see above).

## Consequences

- Free/Student users see and can select `github-copilot/auto`; paid users see it
  too (matches VS Code's picker, where Auto exists across plans).
- Routing adds one session call plus at most one 1s intent call per
  (re)selection; continuations and retries pay nothing extra.
- Cache warming is skipped for routed requests (pre-existing virtual-model
  behavior: warming only runs for the selected model), so Auto conversations
  do not pre-warm the prompt cache.
- Extensions can override the built-in by re-registering a virtual model with
  the same provider and id; `registerVirtualModel` replaces by (provider, id).
- The intent request body omits `session_id` (the router does not receive the
  agent session id); observed dialects accept this. If a future Copilot
  revision starts requiring it, plumb `sessionId` through `ModelRouteRequest`
  rather than guessing ids.
