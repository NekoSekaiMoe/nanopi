# Agent Note: In-context compaction replays a captured next request

Status: implemented

## Problem

`compaction.inContext` generates the summary by repeating the request the next turn would send and appending summary instructions. The provider only reads its prompt cache when the repeated prefix matches that request. The session rebuilt the request by hand: it projected the context, applied `transformContext`/`convertToLlm`, and collected a short list of stream options. That list missed fields the agent loop passes on every request, especially `tools`, request `metadata`, and the resolved API key expression `(getApiKey || config.apiKey)`. A provider that includes those fields in its cache payload key drops the whole prefix and returns `cacheRead: 0`, defeating the feature.

pi-arcweld's `cache-preserving-compaction` avoids this by replaying a captured native request, but it swaps nanopi's decision policy for "never compress if the replay misses". nanopi already has the safer policy (model/TTL/cost gate and fallback to a standalone summary); only the capture step was approximate.

## Decision

`Agent.captureNextRequestConfig()` returns `{ context, config }`: a `createContextSnapshot()` context and a `createLoopConfig()`-derived config with the active request metadata and the resolved API key filled in. Queue callbacks are cleared because a replay has nothing to drain. `AgentSession._runInContextCompaction()` sends the summary with this pair, overriding only `toolChoice: "none"` and the current abort signal, and keeps its existing forced-system-prompt replay and failure stages.

The pair is necessary rather than a single config: the loop takes tools from `AgentContext.tools` and builds the provider's leading system message from them, while stream options come from `AgentLoopConfig`. Returning either alone still leaves a cache-key field out.

The captured config is a snapshot, not a live loop handle. Tool calls in the in-context response are still rejected, and a rejected response still falls back to `compact()` with the reason recorded in `CompactionEntry.details`.

## Alternatives considered

- **Copy pi-arcweld's native request snapshot into the extension layer.** Rejected: it captures the provider payload after transport-specific serialization and would bypass nanopi's model/TTL/cost decision, the standalone fallback, and the compaction entry format.
- **Extend the hand-built option list with `tools`, `metadata`, and `getApiKey`.** Rejected: the same drift recurs whenever the loop gains an option. Reusing `createLoopConfig()` keeps the replay in step with the loop.
- **Capture the last sent provider request from `CacheWarmer`.** Rejected: warming stores a context/options pair for a one-token replay, not the next-turn request configuration, and coupling compaction to warming would make the decision depend on an unrelated mode.

## Consequences

- In-context compaction now includes the same tool declarations, metadata, and resolved API key as a normal turn, so cache hits no longer depend on the replay code remembering every option.
- The API key is resolved by `captureNextRequestConfig()` once at capture time; expiring keys are still refreshed per real request, and a summary is a single request.
- `NextRequestConfig` is public through `@nanopi/pi-agent-core`; it describes a captured request, not a way to run the loop.
- Tests: `packages/agent/test/request-identity.test.ts` checks the captured context/config fields; `packages/coding-agent/test/suite/agent-session-in-context-compaction.test.ts` checks that the summary request replays metadata, key, tool declarations, and the cached prefix.
