# Agent Note: OpenCode Zen catalog base URLs carry the family route

Status: implemented

## Problem

Every `opencode` / `opencode-go` model shipped `<root>/v1` (or `<root>` for
Anthropic), so the four protocols all posted to a route Zen does not serve:

```text
POST https://opencode.ai/inference/v1/chat/completions       404
POST https://opencode.ai/inference/v1/messages               429  (route matched)
POST https://opencode.ai/inference/v1/responses              429  (route matched)
POST https://opencode.ai/inference/anthropic/v1/messages     400  (route matched, unknown model)
GET  https://opencode.ai/inference/v1/models                 200
POST https://opencode.ai/inference/openai/v1/chat/completions 429 (route matched)
```

`/inference` routes per provider family: only `<root>/openai/v1`,
`<root>/anthropic/v1` and `<root>/google/v1beta` exist. `<root>/v1/chat/completions`
is a 404 on every free model, which is what `pi-fake-opencode` could not fix from
the module side — `before_provider_request` sees the body, and no module event
carries the URL.

## Decision

The generator asks models.dev where each model is served instead of deriving it.
models.dev already publishes it: `opencode.models[id].provider.api` is the
served base URL (`https://opencode.ai/inference/openai/v1`,
`.../anthropic/v1`, `.../google/v1beta`, and the `.../inference/go/...` variants
for OpenCode Go).

`resolveCatalogBaseUrl(api, basePath, publishedBaseUrl, familyRoutes)` in
`packages/ai/scripts/model-data.ts` picks the base URL:

1. `publishedBaseUrl` when models.dev has one under the lane root.
2. Otherwise the lane decides. `familyRoutes: true` (`/inference`,
   `/inference/go`) rewrites a chat-completions or Responses base URL to
   `<root>/openai/v1`; `familyRoutes: false` (`/zen`) keeps `<base>/v1`, since
   the 1.x lane predates the family layout.
3. The Anthropic SDK appends `/v1/messages` to its base URL itself, so an
   Anthropic base URL is stored one segment below the published route
   (`.../anthropic/v1` → `.../anthropic`). Storing the published route gives
   `/v1/v1/messages`.

The lane table in the generator gained an `opencode-zen-v1` variant
(`https://opencode.ai/zen`, `familyRoutes: false`) so the 1.x lane stays modeled
without inventing a per-family rewrite for it.

`laneForBaseUrl` in `pi-fake-opencode` matches the lane on the URL path, not on
a `/zen` suffix: `/inference/openai/v1` and `/inference/anthropic` are 2.x, a
path at or below a bare `/zen` is the 1.x gate, and `/zen/go` stays 2.x. The
unused `isV2InferenceBaseUrl` export is gone.

## Alternatives considered

- **Rewrite the URL in `pi-fake-opencode`**: rejected. Requests are built from
  `model.baseUrl` inside `createProvider`, and the module API has no event that
  reaches the URL; `before_provider_request` only sees the body. Fixing it in the
  catalog fixes every consumer, including `models.json`-free ones.
- **Teach `createProvider` a per-api base URL**: rejected. The provider is built
  before modules load and the model carries the base URL, so this buys nothing
  the catalog cannot already express, and the catalog is regenerated from
  upstream anyway.
- **Hard-code the four family strings in the generator**: rejected. `GET
  <root>/v1/models` is authoritative and moves with the gateway; reading
  `provider.api` from the same models.dev payload keeps one source of truth and
  needs no edit when Zen adds a family.
- **Keep `<root>/v1` for the 1.x `/zen` lane and rewrite it too**: rejected. The
  `/zen` lane serves `<base>/v1/...` as-is; adding `/openai` there would invent a
  route nothing captured.

## Consequences

- Chat completions, Responses, Anthropic and Google requests now reach a route
  the gateway serves. The request URL is asserted end to end in
  `packages/ai/test/opencode-baseurl.test.ts`, one case per protocol, against the
  generated catalog.
- The Anthropic base URL no longer ends in `/v1`, which is a shape change
  visible to anything reading `model.baseUrl`. Nothing joined `/v1` onto it by
  hand; the SDK owns that path segment.
- A model whose models.dev entry lacks `provider.api` still gets a working base
  URL through the family fallback, so an upstream data regression degrades to the
  guessed layout rather than breaking the lane.
- `pi-fake-opencode`'s lane detection now reads the path, so the per-family base
  URLs it will see are classified correctly; its body shaping is unchanged.
