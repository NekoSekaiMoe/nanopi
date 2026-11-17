# Agent Note: Compaction Key Facts use text refs, not a sidecar ledger

Status: implemented

Ref: shinytale/nanopi#767

## Problem

Issue #767 asked what nanopi could borrow from `billion-context`. One concrete idea was recoverable
summaries: instead of a one-shot handoff that only contains what the summarizer decided to keep,
give the compacted facts stable references and let the model re-inject the original messages for
one of them when the compressed text is not enough.

The hard part is not the tool, it is where the ref-to-entry mapping lives. A process-local map is
lost on session resume or fork, exactly when a long session is most likely to need a ref. A sidecar
file or custom session entry type would add a second store that can drift from the summary text,
plus a new on-disk format for one feature.

## Decision

The mapping is written into the stored summary itself. Each fact becomes one line in a
`## Key Facts` block:

```
- c0r2: first line of the original message (entry 01J...)
```

`c<checkpoint index>r<fact index>` is stable across compactions. The line carries the session entry
id, so `recall_context(ref)` resolves the ref by scanning the Key Facts rows of every compaction
summary on the active branch, reading the entry with `sessionManager.getEntry()`, and projecting it
with `sessionEntryToContextMessages()`. No in-memory ledger, no sidecar file, no new entry type.

Only entries that are actually being summarized get a ref. The block is capped at 30 facts so the
appendix stays small. A ref whose backing entry is gone reports an error rather than silently
returning an unrelated message.

The KEEP/DROP/PRIORITY summarization prompt rules from the same issue are PR1's scope and are not
duplicated here; this PR only changes the stored summary format and adds the recall tool.

## Alternatives considered

- **Process-local `Map<ref, entryId>` in the module.** Simplest to implement, but it dies on resume,
  fork, or module reload. The tool would appear in the prompt and then answer "unknown ref" for
  every summary written before the restart — worse than not having the tool.
- **Sidecar file or custom session entry for the ledger.** Durable, but it creates a second source of
  truth that must be written atomically with the compaction entry and copied on fork/import. The
  summary already travels everywhere the ledger would; putting the mapping in the text removes the
  synchronization problem.
- **Full billion-context block tiers with decompress/search tools.** That design needs a SQLite
  kernel, a 12-table schema, and a multi-round tool loop. nanopi already keeps raw entries behind
  `firstKeptEntryId`, so one ref per summarized entry plus a single recall tool gets the useful half
  without reshaping the session store, permissions, and RPC surface.
- **Refs on every message in the transcript.** Would make refs available before compaction, but the
  point is to recover what compaction removed. Numbering only summarized entries keeps refs stable
  and short.

## Consequences

- `recall_context` is registered by the built-in `codex-compaction` module, so a build without that
  component has neither the Key Facts writer nor the reader.
- The ref resolution reads plain text with a strict line regex. Changing `formatKeyFacts()` output
  requires changing `findEntryIdForRef()` with it; `packages/coding-agent/test/codex-compaction.test.ts`
  pins the round trip in both directions.
- Recalled messages are injected as a tool result, which enters the context at the point of the call
  and is itself summarized away by the next compaction. This is a deliberate escape hatch, not a
  replacement for keeping important context in the retained tail.
- Refs are scoped to the active branch. A ref written on a branch that was later left is not
  resolvable from the current branch, which matches how `firstKeptEntryId` already works.
