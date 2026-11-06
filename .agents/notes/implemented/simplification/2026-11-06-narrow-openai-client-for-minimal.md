# Agent Note: a narrow `openai` client for a build with one API

Status: implemented

## Problem

Issue #540 followed the undici work of #535: with `apis` trimmed to
`apiSets.openai`, the `minimal` single file still paid 1379 KiB for the `openai`
package — measured from the esbuild metafile, 398 KiB of it added by the 11-05
renovate bump alone. `openai-completions.ts` imports `OpenAI` from the package
root, whose barrel aggregates every resource (responses, assistants, realtime,
beta, admin, vector stores, ...), and the client constructor instantiates all of
them, so `client.chat.completions` is the only resource the flavor can reach and
everything else ships regardless.

The repository's existing trims do not apply: `build-apis.mjs` and
`build-components.mjs` alias own source modules (`*.lazy.ts`, grammars, OAuth
loaders), because the export names are validated against a stand-in. `openai` is
a third-party package with an isolated pnpm layout and no per-resource subpath
exports for the resources the client needs, so no define and no `.lazy` stand-in
reaches inside it.

A first attempt aliased `openai` to a module that subclassed `OpenAI` from
`openai/client.mjs` and replaced `chat` with one resource object. That compiled,
but saved 8 KiB: importing `client.mjs` at all is what pulls the resource tree,
through the class body's own references to the resource classes it instantiates.
The barrel and the client module are the same graph.

## Decision

`packages/ai/src/api/openai-chat-completions-client.ts` implements the one method
`openai-completions.ts` calls — `chat.completions.create(body, options)` and its
`.withResponse()` — on top of the SDK pieces that path actually runs, and
`scripts/build-openai-client.mjs` resolves the bare `openai` specifier to it for
builds whose API set is exactly `["openai-completions"]`, which today is
`minimal` and only `minimal` (issue #540: "1 只对 minimal 生效").

What stays the SDK's code, not a reimplementation:

- `core/api-promise.mjs` for the returned promise and its `.withResponse()`.
- `core/streaming.mjs` `Stream.fromSSEResponse` for SSE framing, the `[DONE]`
  sentinel, `error` events and abort handling, plus
  `lib/chat-completions/streaming.mjs` for the per-chunk normalization.
- `core/error.mjs` `APIError.generate` for the status/`error`/`headers` shape
  `normalizeProviderError` reads, which is what turns a 429 body into the
  provider message a user sees.

What this module owns is the JSON request the full client would have built:
base-URL joining, the same header set, JSON body encoding, the retry policy
(`x-should-retry`, 408/409/429/5xx, `retry-after`/`retry-after-ms`, the 0.5s
doubling backoff with jitter) and the request timeout. Those are ~120 lines of
the SDK's `client.mjs` with the provider, x509/workload-identity and data-residency
branches removed; the chat-completions caller sets none of those options.

The importer is unchanged in the full build. `openai-completions.ts` declares a
`Pick<OpenAI["chat"], "completions">` and reads the client through it, so the SDK
type checking still covers the call. Types keep coming from the package in every
build — only the runtime client is swapped — so an SDK release that renames or
moves a symbol fails `tsc` instead of silently changing behavior at runtime.

Scope is one value, the resolved API set, not a second flavor switch:
`usesNarrowOpenAIClient` matches the list exactly. A flavor that gains
`openai-responses`, `azure-openai-responses`, `openai-codex-responses` or
`openrouter-images` — all of which use other parts of the SDK — keeps the full
client, which is why `base` and `full` are untouched.

`scripts/check-openai-client-size.mjs` (wired into `pnpm run check`) bundles the
implementation with the swap enabled and fails when `openai` contributes more
than 300 KiB. It is a tripwire for the two silent regressions: the swap stopping
(the barrel is back) and an SDK bump growing the narrow surface. It is not a
byte-for-byte lock.

## Alternatives considered

- **Keep the full SDK and accept the 119 KiB (option 4 in #540).** The undici fix
  alone was ~162 KiB and minimal ≈ 2.5 MiB. Rejected because the measurement
  showed the cost is 1.2 MiB, not 119 KiB: the 119 KiB was only the delta of one
  dependency bump on top of a cost the flavor had been paying all along.
- **`pnpm patch` / vendor a trimmed SDK.** Removes the resource imports from the
  barrel, at the price of carrying a fork that every renovate bump has to be
  re-applied against. The narrow entry reaches the same 1300 KiB without owning
  a copy of the SDK.
- **A deep-import client that subclasses `openai/client.mjs`** (the first
  attempt). Measured 8 KiB saved, see Problem.
- **Replace the SDK with a hand-written HTTP client in `openai-completions.ts`.**
  That file is shared by every flavor, so the SSE/error/retry behavior would have
  to be re-verified for `base` and `full` too, and the SDK's error shape would
  become this repository's contract to maintain. The narrow module keeps the SDK
  responsible for all of it.
- **Apply the swap to `base`.** `base` ships `openai-responses`,
  `azure-openai-responses`, `openai-codex-responses` and `openrouter-images`,
  each of which imports something the narrow client does not carry. There is no
  request path to cover them with one entry.

## Consequences

Measured with `NANOPI_BUILD_FLAVOR=minimal node
scripts/build-coding-agent-single-file.mjs`, esbuild metafile attribution on the
same tree:

On `main` at `81ec3e508` (which already carries the undici define of #535), the
same tree built twice, once with the swap disabled:

```
openai    1379 -> 61 KiB   (236 -> 11 modules)
artifact  2,655,211 B -> 2,266,491 B   (2.5 -> 2.2 MiB, -380 KiB)
base      unchanged: 1379 KiB openai, no "narrow openai client" marker
```

- The minimal artifact drops to 2,266,491 B, under the 2,478,646 B the 10-22
  trim left behind and under the 2.37 MiB historical baseline.
- `openai-completions.ts` gained one indirection (`OpenAICompletionsClient`) and
  no behavior change: the full build's runtime path is the same SDK object it
  was before.
- The narrow module is a maintained copy of a request path. When an SDK release
  changes retry or timeout semantics, `pnpm run check:openai-client-size` does not
  see it — the size stays flat. The five cases in
  `packages/ai/test/openai-narrow-client.test.ts` (streaming with
  `.withResponse()`, header/body shape, status error, retry, SSE error event) are
  what pins the behavior.
- `base` and `full` still ship the full SDK and read its 1.4 MiB; the same door
  is open for them if an API set ever shrinks to one resource.
