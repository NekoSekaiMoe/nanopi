# Agent Note: `/btw` answers a side question without adding it to the session

Status: implemented

## Problem

A question that is *about* the work rather than part of it — "why did we pick the
git-ref snapshot?", "what does this regex actually match?" — has no good place in
a session. Asked as a normal turn it costs the context three times: the question
and the answer stay in the transcript forever, the model may answer by running
tools instead of by reading, and the next turn inherits a detour it never asked
for. Asked in a second terminal it costs the thing the user was trying to keep:
the conversation it is about.

`subagent` is not the answer. It isolates *work*: a child session with its own
tool loop, a working tree, and a report written to disk. A side question needs
isolation with none of that machinery, and it needs the answer visible.

## Decision

**`/btw <question>` is a module-owned command with a module-owned message type.**
`pi-btw` calls `ctx.modelRegistry.complete` directly — no tools, no session, no
follow-up turn — and appends the answer as a `custom` message of type `btw`.

**The `btw` codec projects to nothing.** `registerMessageType({ kind: "custom",
customType: "btw", toLlm: () => [] })` puts the row in the transcript and in the
session file while keeping it out of every request. This is the whole feature:
`display: true` plus an empty projection means the answer is durable for the
human and invisible to the model.

**The side thread is per-session, in memory, capped at 8 exchanges.** A second
`/btw` sends the first question and answer along with the new one, so the side
thread builds up the way a conversation does. It is deliberately not persisted as
model context: persisting it would make it the thing this feature exists to
avoid. A new session starts a new thread (`session_start` clears it).

**The conversation travels as the tail, newest first, text only.** `transcriptExcerpt`
walks the projection backwards under a 24k-character budget with a 6k cap per
message, and keeps only `user` and `assistant` text. Tool calls and results are
dropped rather than summarized: they are the bulk of a transcript and the least
of what a side question is about, and a truncated tool payload reads as a fact
the model would then reason from. Newest-last means a budget cut loses the
beginning of the session, which is the part a side question rarely means.

The system prompt states the three constraints the model cannot otherwise know:
it can run no tools, it cannot change anything, and the earlier side questions
are a thread it is continuing rather than part of the session.

## Alternatives considered

- **Send the question as a normal user message and compact afterwards.** The
  detour still reaches the running turn, and compaction is a lossy whole-context
  operation triggered by budget, not a per-message delete.
- **Reuse `subagent` (spawn a child with the excerpt in the task).** A spawn costs
  a process, a session file, and the child's own prompt; the child's value is its
  tool loop, which a side question must not have. `pi-btw` is one HTTP round trip.
- **Put the answer in the transcript as a `system` or `user` message.** Both
  roles are projected to the LLM by definition, so the answer would be in the next
  request — the exact cost being avoided.
- **Persist the side thread to a file so it survives a resume.** The thread is
  about a conversation that has moved on; after a resume the excerpt is the same
  and re-asking is one command. A file would need a format, a scope (per session
  id?) and a cleanup story for a feature whose point is to be cheap.
- **Keep full tool traffic in the excerpt.** Faithful, and it spends the budget on
  the least relevant part first: a few `read` results fill 24k and the question
  loses the discussion it was about.

## Consequences

- The answer is in the session file, so `/export` and the transcript both carry it;
  the next request does not.
- Cost per `/btw` is the tail of the conversation plus the question, sent once.
  Repeated `/btw` calls grow the side thread until it is capped, so a long side
  thread eventually costs what a turn would.
- The model cannot look anything up. An answer it would need a `grep` for comes
  back as "the conversation does not say", which is the intended failure: a
  question that needs tools is work, and work has `subagent`.
- `pi-btw` is in `CHILD_MODULE_SKIP` (`pi-subagent-mini`): a `-p` child has no
  side thread to ask beside, and loading it there would only register a command
  nothing can type.

## Testing

`packages/coding-agent/test/pi-btw.test.ts` covers the excerpt (text-only, newest
tail under a budget, per-message clipping) and `buildContext` (session before side
thread, empty excerpt omitted). The command itself is a single `complete` call
with no branching worth a fake provider; the shape it depends on — a `custom`
codec with an empty projection — is the built-in contract in
`core/messages/registry.ts`.
