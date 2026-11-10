# @NekoSekaiMoe/pi-fake-opencode

A builtin nanopi module that makes requests to [OpenCode Zen](https://opencode.ai/zen) look like traffic from the official OpenCode client, unlocking Zen's free tier from within nanopi.

```text
Error: OpenAI API error (403):
{"type":"FreeTierError","message":"Error from provider (Console):
 OpenCode's free tier can only be used from within OpenCode"}
```

## Why this exists

Zen's free-tier gate only accepts requests that look like they come from the OpenCode app. nanopi announces its own identity, so free models fail with `FreeTierError` even when the request is otherwise valid. The gate's rules are closed-source; they were re-derived black-box in 2026-10 and are re-checked against [opencode2api](https://github.com/jasonxu114514/opencode2api), a Go gateway that replays the official CLI's traffic.

**Three checks, all mandatory:**

| # | Signal | Requirement | Failure mode |
| --- | --- | --- | --- |
| 1 | `User-Agent` | Per lane: the v2 lanes (`/inference`, `/zen/go`) take `opencode/latest/{v}/cli`; the v1 `/zen` lane takes `opencode/{v} ai-sdk/provider-utils/{v} runtime/bun/{v}`. | `FreeTierError` (stale versions: `UpgradeRequired`) |
| 2 | `x-opencode-session` / `x-opencode-session-id` / `x-opencode-request` | Well-formed ids: session ids **descending** (`ses_` + 12 lowercase hex of the low 48 bits of `~(ms*0x1000+counter)` + 14 base62 chars), request ids **ascending** (`msg_…`, one per user turn). | `FreeTierError` |
| 3 | Body shape | The system slot must start with the official CLI system prompt; the tool list must be the official definitions; the body must stream, and a chat body carries `max_completion_tokens` plus `stream_options.include_usage`. | `FreeTierError` |

Explicitly ruled out (each tested with the other signals held correct): TLS/HTTP stack (the same request passes from curl, Node/undici, and Bun), source IP, HTTP version, cookies, connection reuse, and unconstrained body parameters.

## What it does

Two hooks, both scoped to OpenCode-bound requests only.

**`before_provider_headers`** — overwrites exactly the identity headers the official client sends:

| Header | Value |
| --- | --- |
| `User-Agent` | `opencode/latest/2.1.1/cli` on the v2 lanes, `opencode/1.19.3 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` on v1 |
| `x-opencode-session-id` | `ses_…` — stable per nanopi session (descending id) |
| `x-opencode-session` | same value |
| `x-opencode-request` | `msg_…` — one id per user turn (ascending id) |
| `x-opencode-client` | `cli` (honors `OPENCODE_CLIENT`) |
| `x-opencode-project` | the repo root commit, or a random 40-hex id outside a repo |

The project id is not cosmetic: the free tier ledges quota per project and egress, so a fixed value shares one bucket with every client that sends it.

**`before_provider_request`** — reshapes the body into the accepted form (`payload.ts`), one shape per wire protocol:

| Protocol | System slot | Tool list |
| --- | --- | --- |
| `openai-completions` | one leading `system` message (all system/developer messages folded) | `tools[].function` |
| `openai-responses` | top-level `instructions` | `tools[]` (flat `name`) |
| `anthropic-messages` | top-level `system`, string or block list | `tools[]` with `input_schema` |
| `google-generative-ai` | `config.systemInstruction` | `config.tools[].functionDeclarations` |

Each shape does three things:

1. Puts the official CLI prompt (with its `<env>` block and skill listing) at the head of the system slot, then a separator telling the model to follow the operator's instructions, then nanopi's real system prompt verbatim.
2. Renames nanopi's tools to opaque wire names (`clint_<digest>`, opencode2api's `ClientToolWireName`) and appends the official tool set in the CLI's order. nanopi's own tool names and schemas never reach the gateway. An official tool one of nanopi's tools can serve is also declared a second time, under that tool's wire name — see below. History and `tool_choice` references are renamed with them, and a history entry naming a tool the request can no longer act on is dropped with its result, so the request stays self-consistent.
3. Forces `stream: true`; a chat body also gets `stream_options.include_usage` and `max_completion_tokens` (from `max_tokens` when the caller capped it).

The lane picks the assets: a base URL at or below a bare `/zen` path is the 1.x generation (`bash`, the bare User-Agent), everything else the 2.x CLI (`shell`) — including Zen's per-family routes (`/inference/openai/v1`, `/inference/anthropic`, `/inference/google/v1beta`) and `/zen/go`. opencode2api splits the same way (`models.IsV1Upstream`).

Authorization, the endpoint, and every other header stay exactly as nanopi and the selected provider configured them.

A request is spoofed when **any** of these holds:

- the model's provider is `opencode` or `opencode-go` (nanopi's built-in Zen providers), or
- the model's base URL contains `opencode.ai` (custom `models.json` providers pointing at `https://opencode.ai/inference`), or
- the provider id is listed in `PI_FAKE_OPENCODE_PROVIDERS`, or
- `PI_FAKE_OPENCODE_ALL` is set truthy.

### Why some tools appear twice

The injected prompt names the official tools, so the model asks for `shell` or `read`, but the upstream never returns an official name: it redirects the call to the client tool it resolved it to (`shell` → `Bash`, `read` → `Read`, …) and only recognizes another client's vocabulary. nanopi's tool ids happen to match the official names, so that redirect lands on `bash` / `read`, and the returned call names a tool that would otherwise not be declared.

That is what `OFFICIAL_TOOL_CLIENTS` in `payload.ts` describes, mirroring opencode2api's `OfficialToolCandidates`: for every official tool whose counterpart nanopi declared, the official definition is also emitted under that tool's wire name. The model fills in the official schema and the upstream shrinks it to the client tool's own at call time.

A history entry (`tool_calls`, `tool_use`, `function_call`) naming an official tool with no such counterpart is dropped together with its result, and a `tool_choice` pinning it goes too. Without that, the ghost name survives in the history and later turns imitate it.

## Consequences

- **The model drives the session through the official tools, and the call lands on whichever nanopi tool the upstream redirected it to.** The definitions the model sees are OpenCode's, so a call arrives carrying arguments shaped for the official schema. nanopi's tool receives them, which is why `shell` reaches `bash` at all — but a schema mismatch is possible wherever the two differ.
- **The rename is one-way.** `shapeForGateway` returns the wire-to-client table, but the module API has no response hook, so a call the upstream could not redirect keeps the name the upstream sent. opencode2api restores names on the response side (`ToolRenames`); the module API has no such hook, so the declaration up front (`OFFICIAL_TOOL_CLIENTS`) is what makes the mapped case work.
- The prompt is the official CLI prompt plus nanopi's own after a separator. Small free models may weight the CLI's "answer in fewer than 4 lines" style more heavily than a clean prompt would.
- Free-tier usage is still subject to Zen's rate limits and terms. This module only fixes client identification, not entitlement.

## Configuration

Environment variables are read when requests are built:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_FAKE_OPENCODE_VERSION` | `2.1.1` (v2) / `1.19.3` (v1) | Version segment of the User-Agent. Keep it recent — the gateway rejects stale versions with `UpgradeRequired`. |
| `PI_FAKE_OPENCODE_UA` | unset | Full User-Agent override. |
| `PI_FAKE_OPENCODE_PROVIDERS` | unset | Comma-separated extra provider ids to spoof. |
| `PI_FAKE_OPENCODE_ALL` | unset | When truthy, spoof every request. |
| `OPENCODE_CLIENT` | `cli` | Mirrors opencode's own env var for `x-opencode-client`. |

Assets live in `src/gateway-prompt.ts` (system prompt, skill listing, both tool orders) and `src/gateway-tools.ts` (both tool sets). When the gateway starts rejecting them, recapture both from a working official client and replace them verbatim.

## License

BSD-2-Clause
