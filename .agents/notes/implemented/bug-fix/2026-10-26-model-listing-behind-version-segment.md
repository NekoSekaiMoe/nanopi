# Agent Note: One model-listing reader, and it probes the version segment

Status: implemented

## Problem

Two places ask an endpoint what models it serves, and each built its own URL:

- `discoverModels` (the settings page button, and `POST /providers/discover-models`)
  joined on `{baseUrl}/models`, or `{baseUrl}/v1/models` when the account was
  Anthropic-shaped.
- `refreshWithLiveCatalog` (the built-in catalog refresh from #228) joined on
  `{baseUrl}/models` unconditionally and sent a bearer token.

A models.json entry may be written either way. The chat request appends
`/chat/completions` to whatever `baseUrl` says, so `https://gw.example` and
`https://gw.example/v1` both work there — but their listings are not at the same
path. A gateway written as `https://gw.example/v1` made the refresh ask
`https://gw.example/v1/models` (fine), and one written as `https://gw.example`
made it ask `https://gw.example/models`, which most gateways answer with 404.
The refresh treats a rejection as "keep the packaged snapshot", so the failure
was silent: nothing logged, the stale list stayed. The settings button failed the
other way: it reported the 404 to the user and offered no second path.

## Decision

`packages/coding-agent/src/core/model-listing.ts` is the only `/models` reader.
Both callers go through `fetchModelListing`, so the two cannot disagree about
which path lists models or which header carries the key.

- Timeout (10s), the 500-row cap, and the payload shapes (`data[].id`,
  `models[].id`, plus the `display_name`/`displayName` spellings) live there
  once. `parseModelListing` moved out of `live-catalog-provider.ts`.
- `modelListingUrls` probes two candidates instead of one: the base, then its
  `/v1` sibling (reversed when the header marks the endpoint Anthropic-shaped).
  Only when the bare base is what the user wrote does the probe change anything.
- A non-2xx answer on the first candidate is retried on the next, because "wrong
  path" and "bad key" both come back as an error status. The first rejection is
  what surfaces if every candidate fails, so the user reads the URL they can fix.
- A timeout or an aborted caller ends the search: the endpoint is not answering,
  and a second request would just wait out another 10 seconds.

The refresh keeps passing `provider.headers` rather than a protocol flag. A
models.json `anthropic-version` header is what marks a gateway as
Anthropic-shaped, so the header map already carries the signal.

## Alternatives considered

- Keep the two readers and only fix the refresh: rejected — the settings button
  and the refresh would then disagree about which path is authoritative, and the
  next endpoint shape would drift in one of them again.
- Always send both headers (`Authorization` and `x-api-key`): rejected — a
  gateway that mirrors unknown headers into its own upstream can then hold two
  credentials, and the Anthropic SDK rejects a call carrying both.
- Probe `/v1` before the bare base for every protocol: rejected — for an OpenAI
  gateway the bare base is the documented path, and probing `/v1` first costs an
  extra round trip on the common case.
- Persist the successful candidate per provider: rejected — the answer is one
  request at refresh time, six hours apart, and the store already holds a
  catalog that goes stale; a second cached path would go stale beside it.

## Consequences

- Benefit: a hand-written gateway is listed whichever way its `baseUrl` is
  spelled, and a refresh that cannot list anything now differs from one that
  listed the packaged snapshot only by the log, not by a wrong URL in the code.
- Cost: a misconfigured endpoint costs one extra request per refresh, and the
  settings page pays the same. Both are bounded by the 10s timeout.
- Not done: `models-store.json` still stores only dynamic overlays, so an
  OAuth login's model list is re-fetched every start rather than reused. That is
  a separate discussion (#228, the config-file split).
