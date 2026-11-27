# Agent Note: Remove DeepWiki research

Status: implemented

Ref: shinytale/agent/nanopi#861

## Problem

Issue #861 asked to remove DeepWiki-related functionality. After the tool merge in [Git and web research use one name each](2026-11-27-git-and-web-tool-merge.md), DeepWiki was no longer a standalone module. It lived inside `websearch` as the `web` tool's `wiki_structure` and `ask_repo` actions, a JSON-RPC client at `src/modules/websearch/src/deepwiki.ts`, and a `/deepwiki` prompt-prefill command.

The remaining surface is a hosted HTTP call with its own endpoint, timeout, error mapping, and two fields in the shared `web` schema. Keeping it means the web tool still carries failure modes the rest of the chain never produces.

## Decision

`websearch` now registers one `web` tool with `action=search` (default) or `action=fetch`. The DeepWiki actions, the JSON-RPC client, `DEEPWIKI_MCP_URL`, and `/deepwiki` are removed. Search and fetch keep their engine chain, failover, and key cooldown unchanged.

The `git` tool from the same merge is untouched. This is a reduction over the DeepWiki capability only, not a reversal of the one-name-per-capability decision.

## Alternatives considered

- **Keep the actions but hide them from the default prompt.** Rejected: their fields stay in the schema and the JSON-RPC client stays in the build, which leaves the endpoint and failure modes in place while making the behavior harder to discover.
- **Keep `wiki_structure` as a plain web fetch of a docs index.** Rejected: the hosted endpoint answers a different question and its outline format does not come from a public URL. A fetch would only pretend to preserve the feature.

## Consequences

- `web` loses the `wiki_structure` and `ask_repo` actions. A remembered call with either action now returns the normal `web` tool error; there is no alias.
- `/deepwiki` no longer registers. Sessions that prefilled the editor with a `web` action still work through normal tool calls.
- `packages/coding-agent/test/tool-merge.test.ts` and `packages/coding-agent/test/pi-extensions-port.test.ts` drop their DeepWiki cases; the remaining tests cover tool names, git dispatch, and field validation.
- `packages/coding-agent/docs/web-search.md`, the websearch README, and the buildconfig description now describe only search and fetch.

## Verification

- `pnpm run check`
- `node ./test.mjs`
