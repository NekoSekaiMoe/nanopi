# Agent Note: Opt-in compaction growth gate

Status: implemented

## Problem

Threshold compaction has one condition: `contextTokens > contextWindow - reserveTokens`. Near a large threshold, a session can stay barely over the line after a summary. The next request then triggers another summary although almost no new context was consumed. That spends another model call and uses a checkpoint that carries little new information.

billion-context uses a growth gate before compression: the context must be large and must have grown enough since the last compression. nanopi's session has a clean boundary for the same measurement: entries after the latest `compaction` on the branch.

## Decision

`compaction.growthGateTokens` is an opt-in settings value. It defaults to `0`, which preserves threshold-only behavior. When positive, `shouldCompact` requires the estimated tokens added since the latest compaction to reach that value before an automatic threshold compaction runs. `AgentSession` computes the estimate from post-compaction message entries and passes it to `shouldCompact` at both automatic threshold checks.

Manual compaction and overflow recovery do not use the gate. They are explicit or failure-driven, not a second threshold-triggered summary. The gate measures context growth, not wall time or turn count, so a large tool result can satisfy it without a long conversation.

The value is an ordinary compaction setting, not a model override. Growth is a property of the session branch; per-model overrides continue to price the trigger threshold only.

## Alternatives considered

- **Make the gate default-on with a heuristic value.** Rejected: existing sessions would change compaction behavior without a request, and the right value depends on model window and workload.
- **Track growth from persisted usage in `CompactionEntry.details`.** Rejected: the session already has the entries after the last compaction. Adding a second ledger would need schema and migration work for the same measurement.
- **Block all compaction while the threshold is exceeded, including overflow.** Rejected: overflow is a provider failure path and cannot wait for a configurable amount of growth.

## Consequences

- Existing sessions keep the old trigger until a user sets `growthGateTokens`.
- The gate uses `estimateTokens` for messages after the last compaction, so it follows the same tokenizer as the rest of local context accounting. Provider usage remains authoritative for the total that decides whether the threshold is crossed.
- A session with no compaction entry has no growth baseline and is ungated.
- Tests: `packages/coding-agent/test/compaction.test.ts` covers the gate predicate; `packages/coding-agent/test/settings-manager-compaction.test.ts` covers settings resolution and validation.
