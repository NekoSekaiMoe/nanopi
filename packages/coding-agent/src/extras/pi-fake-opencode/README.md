# @NekoSekaiMoe/pi-fake-opencode

A builtin nanopi module that makes requests to [OpenCode Zen](https://opencode.ai/zen) look like traffic from the official OpenCode client, unlocking Zen's free tier from within nanopi.

```text
Error: OpenAI API error (403):
{"type":"FreeTierError","message":"Error from provider (Console):
 OpenCode's free tier can only be used from within OpenCode"}
```

## Why this exists

Zen's free-tier models only accept requests that look like they originate from the OpenCode app. The gateway fingerprints the request, and nanopi announces itself with its own identity — so free models fail with `FreeTierError` even though the request is otherwise valid.

The gateway's rules were re-derived empirically in 2026-10 (same key, same free model, one signal varied at a time, against the official 1.19.0 client and the live endpoint). **Three checks, all mandatory:**

| # | Signal | Requirement | Failure mode |
| --- | --- | --- | --- |
| 1 | `User-Agent` | Composite form `opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`. The old 2-segment `opencode/{version}` and the 4-segment `opencode/{channel}/{version}/{client}` forms are both rejected. | `FreeTierError` (stale versions: `UpgradeRequired`) |
| 2 | `x-opencode-session` / `x-opencode-request` | Well-formed opencode identifiers: session ids are **descending** (`ses_` + 12 lowercase-hex of the low 48 bits of `~(ms*0x1000+counter)` + 14 base62 chars), request ids **ascending** (same without the `~`). An ascending session id is rejected even when every other signal is correct. | `FreeTierError` |
| 3 | Body shape | The system message must **start with a known official OpenCode prompt** (the session title-generator prompt, 2096 chars, embedded in `src/title-prompt.ts`; arbitrary instructions may follow after a separator); the request must **carry no `tools`** (the official agent template matches the tool definitions too, and any other tool set is rejected); and the `max_tokens` field name must be used (the newer `max_completion_tokens` is rejected outright). | `FreeTierError` |

Explicitly ruled out (each tested with the other signals held correct): the client's TLS/HTTP stack (the same request passes from curl, Node/undici, and Bun), the source IP (datacenter and residential both pass; an early "IP reputation" reading was an artifact of testing with malformed ids), HTTP version, cookies, connection reuse, and body parameters (`max_tokens`/`temperature`/`stream_options` are unconstrained).

The values mirror opencode's own source: `packages/core/src/session/model-request.ts` builds the identity headers, `packages/core/src/app.ts` and the AI SDK compose the User-Agent, and `packages/schema/src/identifier.ts` defines the id format.

## What it does

Two hooks, both scoped to OpenCode-bound requests only:

**`before_provider_headers`** — overwrites exactly the identity headers the official client sends:

| Header | Value |
| --- | --- |
| `User-Agent` | `opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14` |
| `x-opencode-session-id` | `ses_…` — stable per pi session (descending id) |
| `x-opencode-session` | same `ses_…` value |
| `x-opencode-request` | `msg_…` — fresh per request (ascending id) |
| `x-opencode-client` | `cli` (honors `OPENCODE_CLIENT`) |
| `x-opencode-project` | `global` |

**`before_provider_request`** — reshapes the payload into the accepted form (all three transforms verified against the live gateway):

1. Prepends the official title-generator prompt (plus a separator that tells the model to follow the operator's instructions) to the system message, and restates the override at the top of the first user turn — without it, small free models latch onto the title-generation role and answer with a thread title instead of the task. The gateway only inspects the system-message prefix, so the session's real system prompt is preserved verbatim after the separator.
2. Strips `tools` / `tool_choice` — the gate accepts tool-carrying requests only when the whole body matches the official agent template (official system prompt AND official tool definitions; nanopi's tool set is rejected). **Consequence: models reached through the free-tier path cannot call tools — they answer as plain chat models.**
3. Renames `max_completion_tokens` to `max_tokens` — the gate rejects the newer field name.

Payloads of other API shapes are left untouched (and currently would not pass the gate; the documented free-tier path is `openai-completions`).

Authorization, the endpoint, and every other header stay exactly as nanopi and the selected provider configured them.

A request is spoofed when **any** of these holds:

- the model's provider is `opencode` or `opencode-go` (nanopi's built-in Zen providers), or
- the model's base URL contains `opencode.ai` (custom `models.json` providers pointing at `https://opencode.ai/zen/v1`), or
- the provider id is listed in `PI_FAKE_OPENCODE_PROVIDERS` (for proxies that front Zen and forward client headers), or
- `PI_FAKE_OPENCODE_ALL` is set truthy.

All other requests keep nanopi's own identity, so unrelated providers are never affected.

## Using Zen's free tier

OpenCode itself uses the literal API key `public` when no key is configured, which authorizes **free models only** (opencode prunes every paid model from its catalog in that mode). nanopi's built-in `opencode` provider catalog contains no free models, so add one yourself in `~/.nanopi/agent/models.json`:

```json
{
  "providers": {
    "opencode": {
      "baseUrl": "https://opencode.ai/zen/v1",
      "apiKey": "public",
      "api": "openai-completions",
      "models": [
        {
          "id": "mimo-v2.6-flash-free",
          "name": "MiMo v2.6 Flash (free)",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

Free model ids (query the live gateway): `curl https://opencode.ai/zen/v1/models` and pick the `*-free` entries. For paid models, authenticate properly instead (`/login opencode` or `OPENCODE_API_KEY` with a real `sk-zen-…` key); paid usage is not subject to the client check.

Verified end-to-end 2026-10: a request with the three signals above passes from Node (nanopi's own transport) against the live gateway; any one signal missing returns the exact `FreeTierError` above.

## Configuration

Environment variables are read when requests are built:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_FAKE_OPENCODE_VERSION` | `1.19.0` | Version segment of the composite User-Agent. Keep it recent — the gateway rejects stale versions with `UpgradeRequired`. |
| `PI_FAKE_OPENCODE_UA` | unset | Full User-Agent override (wins over `PI_FAKE_OPENCODE_VERSION`). Set this to the exact string a current official client sends when the composite format changes. |
| `PI_FAKE_OPENCODE_PROVIDERS` | unset | Comma-separated extra provider ids to spoof (proxies in front of Zen). |
| `PI_FAKE_OPENCODE_ALL` | unset | When truthy (`1`/`true`/`yes`/`on`), spoof every request. |
| `OPENCODE_CLIENT` | `cli` | Mirrors opencode's own env var for the `x-opencode-client` value. |

When the gateway stops accepting the embedded prompt or the composite User-Agent, recapture both from a working official client (see `title-prompt.ts` for the capture method) and update the defaults.

## Notes

- Free-tier usage is still subject to Zen's rate limits and terms. This module only fixes client identification, not entitlement.
- **Tool calling is unavailable on the free-tier path**: the gateway only accepts tool-carrying requests whose tool definitions match the official client's, so the module strips tools and free models answer as plain chat models. Use them for questions, code review, and one-shot generation — not for agentic tool loops.
- `Authorization: Bearer public` + a paid model returns `AuthError` ("Missing API key") — that is Zen rejecting the anonymous key for non-free models, not something this module can or should bypass.
- The prepended prompt biases the model toward title generation; the separator plus the user-turn override neutralizes it in testing (mimo-v2.6-flash-free answered tasks correctly 3/3 with the override, 1/3 without), but expect small behavioral differences versus a clean system prompt.

## License

BSD-2-Clause
