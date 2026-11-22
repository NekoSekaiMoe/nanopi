# Agent Note: Compaction prompt keeps open objectives and quotes verbatim

Status: implemented

Ref: shinytale/nanopi#794

## Problem

Issue #794 collected three reviews of what nanopi should borrow from `billion-context` (BC). The
reviews disagreed on three points: whether to change the `growthGateTokens` default, whether to add
BC's fill-ratio / nudge prompt details, and whether to move compaction toward incremental writes or
add stable message ids. Part of the disagreement came from not distinguishing nanopi's two
compaction paths: the default `codex-compaction` module handles every compaction through
`session_before_compact`, with `generateSummaryWithUsage` as the fallback, and both paths build the
same `SUMMARIZATION_SYSTEM_PROMPT`.

## Decision

Land only two rules, both as text in `SUMMARIZATION_SYSTEM_PROMPT`:

- **Open objectives carry-forward.** A user request in the summarized range that is unfinished and
  not superseded keeps its own line even when this range made no progress on it. A goal lost from
  the summary changes the task the next model sees.
- **Quote fidelity.** User requests, decisions, and constraints are reproduced verbatim, or an
  explicit paraphrase marker is written. A `[rN]`-style reference guarantees a line can be read
  back, not that the wording is accurate; reconstructing a phrase from memory can send the next
  turn into a loop. The rule avoids binding to any tag format because the default path cites
  `[rN]` while the Codex path cites Key Facts refs like `c0r2`.

Everything else in #794 is deliberately left alone. `growthGateTokens` stays at `0`: `shouldCompact`
already requires the total to be near the window, so adding a growth leg only delays compaction
when the total is full but the increment is small, which raises overflow risk in long sessions.
BC's fill-ratio / nudge details do not apply: nanopi has no nudge, compaction is forced by the
framework, and `used X/Y` only appears in the TUI footer and status output, never in a prompt.
Incremental writes are shelved: `prepareCompaction` starts from `prevCompactionIndex + 1` and
summarizes only the increment; the only real difference is that the retained tail and old summary
are summarized once more, which is not worth an architecture change. Stable message ids and
content-described DROP entries already exist in the Codex path as Key Facts labels and `factRef`.

## Alternatives considered

- **Change `growthGateTokens` to ~22.5K.** Strongest argument: it moves compaction toward BC's
  "only compress the post-checkpoint growth" model. Rejected: nanopi's gate is a second condition
  on top of "total near window", so a positive value prevents compaction when the window is full
  but the increment is under the gate, which is later, not earlier, compression. The setting is
  already configurable; only the default was in question.
- **Add fill-ratio hiding and real token counts to the nudge prompt.** Strongest argument: BC
  measured fewer re-fetches from these details. Rejected: nanopi has no nudge and the model cannot
  decline forced compaction, so the failure mode BC fixed does not exist; `used X/Y` does not enter
  any prompt. Copying it would address a problem nanopi does not have.
- **Move to an incremental write model.** Strongest argument: re-summarizing the retained tail
  invalidates a prefix that could be kept. Rejected: the current boundary already limits the
  summarized range to the increment, so the cost is one tail re-summary, an order of magnitude
  lighter than full rewrites. The architecture change is not justified.
- **Add stable ids to every transcript message and a content-description rule for DROP entries.**
  Strongest argument: a controlled experiment linked stable references to fewer re-fetches.
  Rejected: the Codex path already writes `c<idx>r<fact>` refs into the summary and one-line
  content descriptions as Key Facts labels, so a new mechanism would duplicate existing ones.

## Consequences

- Both compaction paths inherit the rules because they share the system prompt; no per-path
  prompt work is needed.
- The rules are advisory text, not a schema check. A model that ignores them still produces a
  summary; `packages/coding-agent/test/compaction-refs.test.ts` pins the rule text so a future
  rewrite cannot silently drop it.
- Summary format, defaults, and compaction trigger behavior are unchanged. Existing sessions and
  stored summaries continue to work without migration.
