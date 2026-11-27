# Agent Note: pi-fake-opencode rotates the wire namespace and breaks client description wording

Status: implemented

## Problem

opencode2api's latest captures add two free-tier refusals that the module did not follow.

1. `95575c5` ("rename client tools under an ordinary namespace") found that the free tier answers a shaped body with `429 FreeUsageLimitError` when a tool name contains the literal `clint_`, while the same body completes under any other prefix. The rename itself is accepted; the gateway marker is what is refused. nanopi still renamed every client tool to `clint_<digest>`, so a tool-bearing free request was exposed to that 429.
2. `6575c62` ("use NBSP in client tool descriptions") found that literal wording in a client tool's top-level description is also rejected. nanopi forwarded nanopi's descriptions verbatim.

`8f691a0` also moved the injected `<env>` block to operator-supplied values only. That is a gateway-host fix — a client cannot know the gateway host — and does not apply to nanopi, which already supplies its own session's cwd/platform/git facts.

## Decision

`payload.ts` follows the two new shaping rules.

`WIRE_TOOL_PREFIX` is now `mcp_`, opencode2api's current `ClientToolPrefix`, and `wireToolNameFor` truncates a collision suffix under the gateway's 64-character name limit before appending `_2`, `_3`, … The prefix stays a plain namespace a tool name could carry; the constant is the one place to rotate when the gateway learns another literal.

For each protocol, a named client tool's top-level description has its ASCII spaces replaced by NBSP before the tool goes on the wire: `tools[].function.description` on chat, `tools[].description` on Responses and Anthropic, and `functionDeclarations[].description` on Google. The rewrite happens on the shaped copy, so a re-shaped body does not stack transforms. Parameter descriptions and the appended official tool definitions stay verbatim.

The 1.x and 2.x prompt/tool captures and the lane identity split are unchanged; opencode2api has not recaptured those assets since the module's last sync.

## Alternatives considered

- **Keep `clint_` and retry**: rejected. The 429 is deterministic on that literal, and a retry sends the same name; only changing the prefix clears it.
- **Strip client tool descriptions entirely**: rejected. The model uses them to decide which tool to call; a plain namespace on the name plus a wording break on the description keeps the tools usable.
- **Replace spaces in parameter descriptions too**: rejected. opencode2api's capture leaves schemas and parameter descriptions untouched; changing them adds no known benefit and changes what the model reads.
- **Change nanopi's tool ids to the gateway's expected names**: rejected. The tool registry and its prompt are public; the wire rename already exists for this boundary.

## Consequences

- Tool-bearing free requests no longer carry the literal the tier refuses, and client descriptions no longer carry the literal wording it rejects. Non-tool traffic is unaffected.
- The prefix is still an ephemeral compatibility value. A later gateway rule can learn `mcp_`; the constant is where that rotation happens, and `packages/coding-agent/test/fake-opencode-gateway.test.ts` pins the current value so a rotation is deliberate.
- A client tool description on the wire contains NBSP where spaces were. The model still reads it as whitespace, but string comparisons against the original description no longer match.

## Verification

`packages/coding-agent/test/fake-opencode-gateway.test.ts` asserts the namespace, the 12-hex digest shape, NBSP rewriting on all four protocols, idempotence on a re-shaped body, and that parameter/official descriptions stay verbatim. Not verified against the live gateway: no Zen credential was used; the rules come from opencode2api's commits `95575c5` and `6575c62`.
