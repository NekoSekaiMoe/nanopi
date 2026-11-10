# Agent Note: provider attribution headers are merged where request options are built

Status: implemented

## Problem

OpenCode's routing identity reached the wire as two headers, and one of them was missing
from requests that carried no attribution of their own:

```text
{"User-Agent": "nanopi/1.0"}                                  every request after the first
{"User-Agent": "nanopi/1.0", "x-opencode-session": "…",
 "x-opencode-client": "nanopi"}                              not what was sent
```

The block was computed in the `transformHeaders` hook that `sdk.ts` installs, so it lived on
the options of that one request. `ModelRuntime.prepareRequest` then merged the caller's
headers into the auth headers and ran the hook over the result, and an OpenAI-family adapter
builds its own set (`{ "User-Agent": …, ...model.headers }`) before `Object.assign`ing the
options headers over it. Which side won came down to whether `transformHeaders` ran, which is
a property of the caller, not of the model.

`ModelRuntime` also had no `SettingsManager`, so the `getProviderAttributionHeaders` decision
could not tell whether install telemetry was on for the session that was asking.

## Decision

Attribution is one function of (model, settings, session id), and it is merged in
`ModelRuntime.prepareRequest` — the single place every chat request passes through — rather
than in a per-request hook:

- `getProviderAttributionHeaders(model, settingsManager, sessionId)` owns the block, and
  `mergeProviderAttributionHeaders` puts it *under* the caller's headers instead of over them.
  A caller that sets `x-opencode-session` itself still wins; a caller that sets nothing gets
  the block.
- `ModelRuntime` holds the `SettingsManager` the session runs with. `ModelRuntime.create`
  takes it optionally (an injected runtime is built before its session), and
  `useSettingsManager` rebinds it when the session is created, so a project's telemetry
  setting is not silently replaced by the user-scope file.
- `isOpenCodeModel` states once which models are served by OpenCode's gateway: the two
  built-in provider ids, or any provider whose base URL host is `opencode.ai`. It replaced two
  copies of that condition.
- `getSessionHeaders` always answers the client header for an OpenCode model and only adds the
  session header when a session id exists. The client header names the app, not the
  conversation; a request from `-p` that names no session is still nanopi talking to the
  gateway.
- `packages/ai`'s `withOpenCodeSessionHeader` adds the same client header at the adapter
  layer, so a direct `Models` consumer gets it too, and both now read the header names from
  the exported `OPENCODE_SESSION_HEADER` / `OPENCODE_CLIENT_HEADER` constants.

## Alternatives considered

- **Fix the OpenAI adapters to merge `model.headers` after the options headers**: rejected. It
  reverses the documented rule that caller values override defaults (`StreamOptions.headers`,
  `packages/ai/src/types.ts`), and it still leaves the next adapter free to make the same
  choice. The block belongs to the request, so it is attached to the request.
- **Have `transformHeaders` be the only source and let every adapter keep what it is given**:
  rejected. Three of the four adapters already append options headers right-to-left
  (`{ ...model.headers, ...optionsHeaders }`, `Object.assign(headers, optionsHeaders)`), so the
  fix would be a rule each adapter has to remember and nothing enforces.
- **Add an `augmentHeaders` hook to `Models` and give `ModelRuntime` a default one**: tried and
  removed. `ModelRuntime.prepareRequest` does not route through `ModelsImpl.applyAuth`, so the
  hook was never called for a session request; it would have been a second, unused merge path
  next to the real one.
- **Claim the attribution block with a marker header so a later request can tell it was
  already applied**: tried and removed with the hook above. The first request through
  `prepareRequest` already carries no attribution, so the marker only ever suppressed the fix.

## Consequences

- The regression test `packages/coding-agent/test/provider-attribution.test.ts` asserts the
  headers an OpenAI-family adapter puts on the wire, not the headers a test provider receives,
  and covers two consecutive requests. Reverting the merge in `prepareRequest` fails it.
- `x-opencode-client` now goes out on OpenCode requests that have no session id, where it used
  to be dropped along with the session header.
- `ModelRuntime` keeps a `SettingsManager` alive for its lifetime. `createAgentSession` and
  `createAgentSessionServices` rebind an injected runtime to the session's manager; the CLI
  paths that build their own runtime pass it to `ModelRuntime.create`.
- Attribution stays chat-only: image and classifier requests carry no attribution block, as
  before.
