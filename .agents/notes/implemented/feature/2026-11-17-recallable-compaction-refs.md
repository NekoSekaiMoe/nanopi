# Agent Note: Compaction refs the model can recall

Status: implemented

## Problem

A compaction summary is a one-way door. `appendCompaction` keeps the raw entries in the session
file, but `buildContextEntries` hands the model the summary plus `firstKeptEntryId` onward, so
everything earlier is gone from the request. The summary is written by a model, and the details
it drops are exactly the ones that are expensive to reconstruct: an exact error string, the
reason a decision was made, the contents of a file read 400 turns ago.

The session file already holds those entries. Before this change nothing could reach them, so a
model that needed one re-read files, re-ran commands, or asked the user.

## Decision

A compaction summary ends with a section listing the regions it replaced, and a tool resolves
one of them back into the request:

- `session_before_compact` (module `compaction-recall`) appends `## Replaced Context (recallable)`
  to the summary, one line per region: ref, a one-line preview, entry count, token size.
- `recall_context({ ref })` resolves the ref against the live branch and answers with the model
  projection of that region's entries.

A **ref is an ordinal over the branch**, `E<n>`, counting model-visible entries from the start of
the transcript. Nothing about the ref is stored: `resolveRecallRef` recomputes the region from
`branchEntries` and the newest compaction's `firstKeptEntryId`, so a ref survives a reload, a
fork, and a `--resume` with no schema change and no id table to keep in sync. A later compaction
renumbers the regions, which is why each compaction rewrites the appendix instead of appending
to the previous one.

A **region is a run of consecutive user turns**, capped at `DEFAULT_RECALL_MAX_TOKENS` (8000).
The cap is the point: recalling must not refill the window the summary just freed. Splitting at
a user message rather than at an arbitrary entry keeps a ref describing a stretch of work, so a
recall does not answer with an assistant reply whose question is still missing.

## How the handler sees the summary it post-processes

`session_before_compact` handlers run in module load order and **the first one that returns a
`compaction` replaces everything after it** (`ModuleRegistry._emit`). The Codex-style handler
that builds the real summary is registered *after* a module loaded from `BUILTIN_MODULES`, so an
appendix handler could never see the text it was supposed to extend, and returning a compaction
of its own would have won the race and thrown the Codex summary away.

`AgentSession` therefore dispatches the event **twice**:

1. Pass one. A handler that builds a summary of its own answers here (`extensionCompaction`).
2. Pass two, only when pass one produced nothing: the default generator runs, and its result is
   dispatched again with `replacedSummary` set.

Pass two behaves exactly like pass one, so the same handler answers on both passes; the recall
handler returns undefined when `replacedSummary` is absent and appends its section when it is
not. `SessionBeforeCompactResult.compaction` is a `Partial<CompactionResult>` because pass two
rewrites the text only: the cut point, token count and usage stay the summary's, and
`AgentSession` merges the partial over the result it replaced.

An extension that builds the summary keeps the pre-change behaviour: it answers in pass one and
no second pass runs, so no other handler can extend its text. That is the price of not changing
the meaning of an existing hook result; a summary built by an extension that wants an appendix
has to call the same helper.

## Alternatives considered

**Store the ref table in the compaction entry and look entries up by id.** Ref stablity across a
reload would be free, and a ref would name exactly one entry instead of a region. It also means
a second source of truth: a forked branch, a `context_edit`, or a compaction that moved the cut
point would leave the stored table describing a transcript that no longer exists. Ordinals are
wrong in a narrower case (a later compaction renumbers them) and are always answerable from the
branch alone.

**Inject the recalled region as a conversation message instead of returning it as a tool
result.** `sendMessage`/`deliverMessage` would put the text in the transcript where the model
cannot mistake it for a tool output. It also means the tool's own turn has to start or queue a
run while it is running, and a message inserted mid-run is exactly the case
`_pendingCustomMessages` exists to defer. A tool result needs none of that: it lands where the
model already looks, and its `toolCallId` ties it to the request that asked.

**Copy bili's design: a block id per message, a stored lineage tree, and a `decompress` tool that
takes a block id.** That is a schema, a store, and a second index to keep consistent with the
jsonl tree. The ordinal scheme gets the same recall on a compatible branch with zero migration.

## Consequences

The summary grows by one line per replaced turn — a 200-turn session adds roughly 200 lines,
mostly previews, because the preview is clipped at 140 characters. That is the cost of telling
the model what is recallable at all; the refs are what make the section useful, and a summary
that omitted them would leave the model with no way to ask.

`recall_context` returns up to 8000 tokens in one call. Two recalls can therefore undo one
compaction's savings, which is why the guideline tells the model to reach for it when the summary
is not enough rather than as a default exploration step.

The previews are built from the entry's first projected message. A region with a long tool-call
argument shows the call, not its result, so the model may have to recall to know what a region
contains. Sorting that out would need a second summarization pass over every replaced region on
every compaction.

## Testing

`packages/coding-agent/test/compaction-recall.test.ts` covers region grouping, the token cap,
ref resolution (including a ref the branch does not carry), the appendix text, the handler's two
passes, and the tool result. The `session_before_compact` double dispatch is exercised through
the handler surface the module receives, not through a live model.
