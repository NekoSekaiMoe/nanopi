# Agent Note: pi-fake-opencode sends the OpenCode 1.19.x gateway fingerprint

Status: implemented

> Superseded in part by [pi-fake-opencode replays the CLI's full request shape](2026-10-30-fake-opencode-free-tier-tool-shape.md): the gate now expects a current CLI (2.x) shape — the full CLI system prompt rather than the title prompt — and a tool list the model can actually drive. The `ses_`/`msg_` id formats and the ruling-out experiments below still hold.

## Problem

The builtin `pi-fake-opencode` module (see `packages/coding-agent/src/extras/pi-fake-opencode/`) unlocks OpenCode Zen's anonymous free tier by making nanopi's requests look like the official OpenCode client. Around 2026-10 users started getting `FreeTierError` ("OpenCode's free tier can only be used from within OpenCode") on every free-model request, while the official open-source OpenCode client kept working from home and datacenter networks alike.

The gateway is closed-source (`FreeTierError` appears nowhere in anomalyco/opencode), so the rules were re-derived by black-box experiment: capture the official 1.19.0 client's real requests (local TLS+h2 capture server via hosts-file hijack), then replay them with one signal varied at a time.

## Decision

The gate checks three signals, and all three must hold. The module now replicates each one:

1. **Composite User-Agent** — `opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`. Neither the pre-1.18 2-segment `opencode/{version}` form (what the module used to send) nor the 4-segment `opencode/{channel}/{version}/{client}` form (read from the 2.x dev branch source — never shipped in 1.19.0) is accepted. The real string is only observable by capturing a live client.
2. **Identifier directions** — opencode ids are `ses_`/`msg_` + 12 lowercase hex (low 48 bits of `ms*0x1000 + counter`) + 14 base62 chars. Session ids use the bitwise-NOT (descending) form, request ids the plain (ascending) form. An ascending session id fails even with every other signal correct — this single byte-level detail caused most of the misleading intermediate readings.
3. **Body-shape whitelist** — the request must look like an official one: the system message must start with a known official OpenCode prompt (the session title-generator prompt, 2096 chars, embedded verbatim in `src/title-prompt.ts`, is a pass key; arbitrary instructions may follow after a separator, so nanopi's real system prompt rides along), the request must carry no `tools` (the official agent template additionally matches the tool definitions, and nanopi's tool set is rejected — so the module strips tools and free-tier models answer as plain chat models), and the `max_tokens` field name must be used (the newer `max_completion_tokens` that pi-ai emits is rejected outright). `before_provider_request` applies all three transforms.

Explicitly ruled out, each tested with the three signals held correct: TLS/HTTP-stack fingerprinting (curl, Node/undici, and Bun all pass — an early transport-level theory was an artifact of testing with malformed ids), source IP reputation (datacenter and residential both pass), HTTP version, cookies, connection reuse, and body parameter values (`max_tokens`/`temperature`/`stream_options` values are unconstrained; a minimal body passes once signals 1–3 hold). Also explored and rejected: reaching the official agent template (which allows tools) by sending the official agent system prompt — it additionally requires the official tool definitions, and replacing nanopi's tools with the official ones would leave the model calling tools nanopi does not register.

## Verification

- Live gateway, Node transport, one signal varied at a time: all three signals present → 200 completion from `mimo-v2.6-flash-free` with `Bearer public`; any one removed → `FreeTierError`. Logged in the extension README's experiment table.
- End-to-end through nanopi itself (`dist/cli.js -p --model opencode/mimo-v2.6-flash-free` against `https://opencode.ai/inference/v1`, `apiKey: public`): free model answered ("4") — the full builtin-module chain (headers + payload shaping) verified on the real gateway.
- Behavior: the title-generator preamble at the top of the system message makes small models answer with a thread title instead of the task (observed: "Quick math check: 2+2" for a math question). The fix is a note prepended to the first user turn (string and OpenAI content-parts forms) stating that the title role does not apply; with it, mimo-v2.6-flash-free answered three different one-shot tasks correctly 3/3.
- Local: header-capturing echo server driven through `dist/cli.js -p` — nanopi's real request path asserts UA shape, descending `ses_` / ascending `msg_` ids, header set, the prepended system prompt, the stripped tools, and the renamed `max_tokens`.

## Alternatives considered

- **Bump only `DEFAULT_OPENCODE_VERSION`** (the first attempted fix, `2.2.2`): rejected — not a real release, and the UA format itself was wrong.
- **Transport-level impersonation** (curl-impersonate-style TLS mimicry, or routing through a Bun forward proxy): rejected after the transport theory was disproven — Node's stock fetch passes once the three signals are right, so no exotic transport is needed.
- **Local `opencode serve` as an OpenAI-compatible bridge**: rejected — the v2 server exposes no OpenAI-compatible API (every path falls through to the web SPA).
- **Prepending the agent prompt instead of the title prompt**: rejected — the gate accepts the title-generator prompt as a prefix but rejected the agent prompt in isolation (the agent-shaped request presumably needs its full body including tools); the title prompt is 2 KB and append-friendly.

## Consequences

- Free-tier spoofing works from nanopi's stock Node runtime again; the module is compiled in via `BUILTIN_MODULES`, so every build carries the fix.
- **Free-tier models are chat-only from nanopi**: tools are stripped to pass the gate, so agentic tool loops do not work on spoofed free models; they are useful for questions, review, and one-shot generation.
- The system message now starts with ~2 KB of fixed OpenCode preamble plus an explicit override separator. Free-tier models verified to follow the operative instructions, but prompts differ from a clean baseline — expect small behavioral drift on spoofed requests.
- The three signals will rot independently: `PI_FAKE_OPENCODE_VERSION`/`PI_FAKE_OPENCODE_UA` cover signal 1 without a code change; signals 2 and 3 are algorithmic constants that need recapture from a live client when OpenCode changes them (capture method documented in `title-prompt.ts`).
