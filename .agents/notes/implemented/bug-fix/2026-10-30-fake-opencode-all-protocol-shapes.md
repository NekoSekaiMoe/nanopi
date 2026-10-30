# Agent Note: pi-fake-opencode shapes every protocol the gate inspects

Status: implemented

## Problem

`pi-fake-opencode` shaped one body: an `openai-completions` payload. Everything else got the identity headers and nothing else.

That is the wrong cut. `packages/ai/src/providers/opencode.ts` wires four chat protocols, and the model catalog spreads the free models across them (`beam-free`, `glm-5.3-flash-free`, `nano...` on completions; `jev-1.13-free` is a classifier). The gate validates the whole request, so a headered-but-unshaped body is the `FreeTierError` the module exists to avoid. The old code was explicit about it — `if (ctx.model?.api !== "openai-completions") return;` — and that line was a bug once the provider started serving more than one wire protocol.

Two smaller things were also wrong against the captures:

1. `shapeForGateway` read `body.messages`, so a Responses body (which carries `instructions` and `input`) was silently left unshaped even though it reached the shaping path.
2. `shapeChatTools` renamed the client tools and appended the official set, but left the *history* and `tool_choice` naming the old names. A tool result for `bash` then referred to a tool the request no longer declared.

## Decision

`shapeForGateway(payload, api, context)` handles the four protocols the gate inspects, one system slot and one tool slot each:

| API | system slot | tool slot |
| --- | --- | --- |
| `openai-completions` | one leading `system` message | `tools[].function` |
| `openai-responses` | `instructions` | `tools[]` (flat `name`) |
| `anthropic-messages` | `system`, string or block list | `tools[].input_schema` |
| `google-generative-ai` | `config.systemInstruction` | `config.tools[].functionDeclarations` |

Every path renames client tools to `clint_<digest>` (opencode2api's `ClientToolWireName`), appends the official set, and renames the request's own references — chat `tool_choice`/`function_call`/`tool_calls`, Anthropic `tool_choice` and `tool_use` blocks, Responses `tool_choice`/`allowed_tools`/`function_call` items — so the body stays self-consistent.

The lane is derived from the base URL, matching `models.IsV1Upstream`: a base URL ending in `/zen` is the 1.x gate (`bash`, bare `opencode/<v>` User-Agent, `opencode/<v> ai-sdk/... runtime/bun/...` on model requests); `/inference` and `/zen/go` are the 2.x CLI (`shell`, `opencode/latest/<v>/cli`). nanopi's built-in Zen base is `/inference`, so the v2 default is the one that runs.

Chat also stops stripping `tool_choice` and gains `stream_options.include_usage`; both are what opencode2api forwards.

## Alternatives considered

- **Babel-style transcode to completions**: rejected — the gate looks at the body the *client* sent on that route. A `/v1/messages` request carrying an `openai` chat body is a shape mismatch the gate never sees from a real client.
- **Convert every model onto one API**: rejected — `opencode.ts` picks the protocol per model because Zen serves each model on one route only; collapsing them would send Anthropic models a chat body they do not accept.
- **Try v1 then retry v2 on 403**: rejected. It doubles the round trips on a rate-limited free tier and needs a response hook to notice the 403, then a second payload transform, which the retry path does not offer.
- **Rewrite the base URL to the family route** (`<origin>/openai/v1/chat/completions`, `.../anthropic/v1/messages`): correct per opencode2api's `v2EndpointPath`, but out of reach from here. `createProvider` streams with the model's `baseUrl` and there is no module event for it; the only lever is `provider.baseUrl`, and the provider is created before modules load. The route is fixed in the catalog instead — see [2026-10-31](../../../implemented/bug-fix/2026-10-31-opencode-family-base-urls.md).
- **Skip `tool_choice` entirely** (the previous behaviour): rejected — a client that pinned a tool had it silently ignored, and the pinned name referred to a tool the gated body no longer declares.

## Consequences

- Free/authenticated Zen models on all four protocols now send a shaped body, not just chat ones.
- `gateway-tools.ts` carries a second set (`bash` for `/zen`). It shares every definition with the 2.x set except that one name, so a recapture of either generation touches one file.
- The rename is still one-way. `shapeForGateway` returns the wire-to-client table, but the module API has no response hook, so a streamed tool call arrives as `clint_<digest>`. opencode2api restores names (`ToolRenames` + `RenameStreamReader`); nanopi cannot yet, and the README says so.
- `wireToolName` stays exported for tests but the shaping path uses the collision-aware variant, so two client tools that hash alike get `_2` instead of one name overwriting the other.

## Verification

- `packages/coding-agent/test/fake-opencode-gateway.test.ts`: 17 cases — lane split, both User-Agent forms, session/request ids, project id, spoof scoping, prompt folding and idempotence, official set in order per lane, chat field renames, and one shaping test per protocol including tool-reference renames.
- `pnpm run check` clean.
- Not verified against the live gateway: no Zen credential was used. The shapes come from opencode2api's captures (`internal/gateway/toolshape.go`, `opencode_prompt.go`, `internal/httpx/client.go`).
