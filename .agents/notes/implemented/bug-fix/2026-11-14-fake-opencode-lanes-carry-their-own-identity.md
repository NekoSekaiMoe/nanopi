# Agent Note: pi-fake-opencode replays each lane's own identity and captures

Status: implemented

## Problem

The module treated Zen's two request shapes as one shape with substitutions. Two
consequences, one per lane:

**The v2 lanes sent a 1.x header.** `before_provider_headers` wrote the same six
values regardless of lane, including `x-opencode-request`. Since opencode2api's
`f0f064f` ("align the v2 free-tier shape with OpenCode 2.0.32") the v2 gate
rejects that header with `403 FreeTierError`, and it expects the conversation
affinity in a shape the module never sent:

```text
x-opencode-session:    <affinity>       # the parent, when forked
x-opencode-session-id: <client session> # the child's own id
x-session-affinity:    <affinity>
X-Session-Id:          <affinity>
x-opencode-request:    (absent)
```

The module sent one id in `x-opencode-session`/`-session-id` and the `msg_` id in
`x-opencode-request` — the v1 layout — so a v2 request carried the header the v2
gate 403s on and none of the three affinity headers it fingerprints.

**The v1 lane sent a 2.x body and a 2.x User-Agent.** `GATEWAY_SYSTEM_PROMPT_V1`
was `GATEWAY_SYSTEM_PROMPT.split("shell").join("bash")` and `GATEWAY_TOOLS_V1` was
`{...GATEWAY_TOOLS, bash: {description: …, parameters: GATEWAY_TOOLS.shell.parameters}}`.
Neither is what an OpenCode 1.19.3 client sends:

- The prompt pair differs in prose too: the 1.x text says "WebFetch" where the
  2.x one says "webfetch", and "Task" where it says "subagent".
- The 1.x tool set is eleven tools, not thirteen renamed: it has `bash`, `task`
  and `todowrite` where the 2.x CLI has `shell`, `subagent` and `question`, and
  carries no `patch`.
- Every shared name (`edit`, `glob`, `grep`, `read`, `skill`, `webfetch`,
  `websearch`, `write`) has a different description and a different schema
  between the two captures. Substituting names kept the 2.x schema under a 1.x
  name, which is the one thing the gate compares per-entry.
- The 2.x chat tools carry `strict: false`; the 1.x capture carries no `strict`
  field. The module added `strict: false` on both lanes.
- The 1.x User-Agent's `ai-sdk/provider-utils` segment is per protocol — `4.0.23`
  for chat, `4.0.40` for responses, `4.0.46` for anthropic — because 1.19.3
  routes each protocol through a different AI SDK package. The module sent
  `4.0.23` for all of them, and never sent the AI SDK's `Accept: */*`.

## Decision

`headers.ts` builds the set per lane, and the lane's own assets are separate
captures.

`buildIdentityHeaders({lane, sessionId, parentSessionId, cwd, api, turn})`
is the one place that knows the difference:

| Header | v2 | v1 |
| --- | --- | --- |
| `User-Agent` | `opencode/latest/2.1.1/cli` | `opencode/1.19.3 ai-sdk/provider-utils/<per api> runtime/bun/1.3.14` |
| `x-opencode-session` | affinity (parent when forked) | the session id |
| `x-opencode-session-id` | the client's own session id (child when forked) | the same session id |
| `x-session-affinity`, `X-Session-Id` | affinity | absent |
| `x-opencode-request` | explicitly `null` (deletes it) | `msg_…` per user turn |
| `Accept` | untouched | `*/*` |
| `x-opencode-parent-session-id`, `x-parent-session-id` | parent, when forked | same |

`x-opencode-request` is written as `null` on v2 rather than merely skipped: the
value may already be in `headers` from pi's own attribution layer, and a stale
one 403s the request. `ProviderHeaders` is `Record<string, string | null>` and the
header event documents `null` as "delete this header", so the module states the
absence instead of hoping for it.

The parent comes from `ctx.sessionManager.getHeader()?.parentSession`, so a
forked session — including a `subagent` child — keeps its own id in
`x-opencode-session-id` while the upstream affinity, quota bookkeeping and prompt
cache stay on the parent. Before this, every forked session looked like a fresh
conversation to the gate.

`gateway-prompt.ts` and `gateway-tools.ts` store the 1.x captures as their own
values (`GATEWAY_SYSTEM_PROMPT_V1`, `GATEWAY_TOOLS_V1`), and `GATEWAY_TOOL_ORDER_V1`
is the 1.x client's order. `renderOfficialTool` takes a `strict` flag that is
true only on v2, so a 1.x definition reaches the wire exactly as captured.

## Alternatives considered

- **Keep one tool table and substitute names per lane** (the previous shape):
  rejected. It only works while the two sets agree on membership and schema,
  which they do not — the substitution produced a 1.x name over a 2.x schema, and
  the gate compares the entry, not just the name.
- **Derive the 1.x prompt from the 2.x one with a list of replacements**:
  rejected. `shell → bash` was already wrong (the 1.x text says `Bash` inside a
  sentence, not `bash`), and every added replacement is a guess about prose the
  capture already answers.
- **Send the v2 affinity headers on both lanes**: rejected. The 1.x client sends
  neither `x-session-affinity` nor `X-Session-Id`, and the module exists to be
  indistinguishable from the client of the lane it is on.
- **Skip `x-opencode-request` on v2 by not writing it**: rejected. Another layer
  may have written it, and "we did not set it" is not the same fact as "it is not
  on the wire".

## Consequences

- The v2 lanes stop sending the header the 2.x gate 403s on, and carry the three
  affinity headers it fingerprints. Free-tier requests on `/inference` should no
  longer be rejected for a 1.x identity.
- A forked session (a `subagent`, a `/fork`) now reports the parent as affinity
  and itself as the session, so its upstream quota and prompt cache follow the
  conversation instead of starting a fresh bucket per child.
- The 1.x lane sends eleven official tools where it used to send thirteen, and
  each carries the 1.x schema under the 1.x name. A model following the 1.x
  prompt can call `task` and `todowrite`, which the previous tool list did not
  declare at all.
- `OFFICIAL_TOOL_CLIENTS` already lists `task` → `Agent`/`Task`/`Subagent` and
  `todowrite` → `TodoWrite`, so the redirect mapping covers the new 1.x names
  without an edit.
- The v1 header set gains `Accept: */*`. A caller that set its own `Accept` on a
  `/zen` request has it overwritten, which matches the client.
- Two captures now live in each asset file, so a gateway change means recapturing
  both generations rather than editing one and re-deriving the other.
