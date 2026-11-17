# Agent Note: A compaction summary cites the session entries it dropped

Status: implemented

## Problem

Compaction keeps the session file and throws away the model's view of it. What survives is prose:
"the bash_bg test failed" is all a later turn has, and the exact assertion, the path plus line
number, and the decision's wording are gone. The raw entries are still on disk and the projection
still knows how to render them, so the loss is not one of data but of addressability: the model has
no way to say "show me the turn that printed that failure".

Issue #767 asked for this after reading billion-context, whose block model keeps history
addressable instead of lossy. Full block lineage is out of reach here (see alternatives), but the
narrow version — let the summary point at an entry, let the model ask for it back — fits the
existing jsonl session without a schema rewrite.

## Decision

Three pieces, each on an existing seam.

**The summary cites entry ids.** `getMessagesFromProjectedEntryForCompaction` stamps
`entryId: <sourceEntry.id>` on every message it hands the summarizer. The summary prompts
(`REF_SUMMARIZATION_PROMPT`, `UPDATE_SUMMARIZATION_PROMPT`, and the in-context user turn) end with
`SUMMARY_REF_INSTRUCTIONS` (`core/compaction/utils.ts`): tag the line with `[r1]`, and define each
tag in a trailing `<refs>` block. The tags are the summary's own numbering, so a rolled-forward
summary restarts at `[r1]` instead of accumulating an ever-growing ledger.

**Recall is an entry, not a tool result.** `SessionManager.appendContextRecall()` appends a
`context_recall` entry holding the recalled text, and `sessionEntryToContextMessages` projects it as
a `recalledContext` message. So the recalled history lands in the conversation as history. A tool
result would be read once and summarized away by the next compaction, which defeats the point of
making the citation durable; an entry is subject to compaction like anything else, and the tool can
be called again.

**The tool lives in its own module.** `recall_context` (`modules/context-recall/`) resolves the
tags against the newest summary's `<refs>` block, refuses a tag the summary never defined, skips
entries that are still inside the kept region, refuses a block over a quarter of the context
window, and appends the entry. The reader (`parseSummaryRefs`, `citedRefIndexes`) sits next to the
tool rather than in `core/compaction/`, because that barrel is budgeted at 20 files
(`scripts/check-entry-graphs.mjs`, see
[2026-11-05](../../implemented/simplification/2026-11-05-compaction-barrel-export-star.md)) and a
parser only this module calls would push it to 21.

The recall message is transcript-invisible: `interactive-mode.ts` skips `recalledContext` when
drawing a run, so the recalled block does not appear twice on screen.

## Why the tag format is prose

The tags have to survive `<previous-summary>` merges, turn-prefix splits, and the in-context path,
all of which are text in, text out. A structured JSON field on the compaction entry would need
every one of those prompts to emit JSON, and a model that answers with prose anyway would lose the
citations silently. Prose tags degrade: a summary with no `<refs>` block recalls nothing, and the
tool says so.

## Consequences

- Every compaction summary now carries an `<refs>` block, which costs a few tokens per summary and
  a few more in the summary prompt. The prompt grew by ~120 words on three paths.
- A summary written before this change has no `<refs>` block; `recall_context` reports that
  instead of guessing, so old sessions keep working unchanged.
- `prepareCompaction` output changed shape: `messagesToSummarize` and `turnPrefixMessages` now
  carry an extra `entryId` field. `packages/coding-agent/test/compaction.test.ts` asserts the new
  shape; no consumer reads the field except the summarizer's prompt.
- Recalled content is copied into the entry. A later context edit to the original does not rewrite
  what was already shown, which is the right behaviour for history but means the session file holds
  the text twice.
- `recall_context` is registered by default and costs one tool declaration in every request, even
  in sessions that never compact. A loadout hook that hides it until a summary exists was
  considered and left out: it would need `prepareLoadout`, which refreshes on tool-set changes
  rather than on compaction, so the declaration would be stale exactly once.

## Alternatives considered

- **Full billion-context block lineage: stable block ids, `decompress`/`search_context` tools, an
  inactive/active split, SQLite ledger.** Strongest argument: it makes the entire history
  addressable, not just what the summary happened to cite, and prefix-cache economics fall out of
  the append-only block model. Rejected: it replaces the jsonl session store with a database and
  the compaction summary with a block index, which is a different product. The citation version
  solves the reported pain (exact details lost at compaction) with four files touched.
- **Put the recalled text in the tool result.** Strongest argument: no new entry type, no
  projection change, the tool is a pure read. Rejected: a tool result is the first thing the next
  compaction summarizes away, so recalling a detail twice per session is the common case rather
  than the exception, and the recalled text is not visibly history — it sits among tool output.
- **Store refs as structured data on the compaction entry (a `refs: {tag, entryId}[]` field).**
  Strongest argument: no parsing, no malformed block, the tool reads a real map. Rejected: the
  `<previous-summary>` merge and the in-context path both pass the summary as text, so the model
  would have to emit a side channel in a second format; one prose format that both the writer and
  the reader agree on is less to keep in sync, and `parseSummaryRefs` is total (an unparseable
  block recalls nothing).
- **Keep the parser in `core/compaction/` next to the prompt that writes the tags.** Strongest
  argument: writer and reader live together, so the format cannot drift. Rejected: the barrel is
  budgeted at 20 files and the note above says to split rather than raise the number; the format
  is pinned from both sides by `packages/coding-agent/test/compaction-refs.test.ts`, which asserts
  the instruction text and the parser against the same fixture.

## Verification

- `pnpm run check`: clean, including the entry-graph budget (the barrel stays at 20).
- `node ./test.mjs`: 2869 coding-agent tests pass.
- `packages/coding-agent/test/compaction-refs.test.ts`: parses a `<refs>` block, ignores
  definitions when counting body citations, treats `(none)` as citing nothing, and asserts the
  instruction text is wired into the in-context prompt.
- `packages/coding-agent/test/suite/agent-session-context-recall.test.ts`: seeds a compacted
  session, asserts the cited text is gone before the recall, drives a `recall_context` call,
  and asserts the `context_recall` entry exists and projects into the conversation; a second case
  rejects an undefined tag, a third reports the no-summary case.
