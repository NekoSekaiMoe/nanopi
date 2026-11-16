# Agent Note: `/retry` replays the last failed run

Status: implemented

## Problem

Retry state lived only in process memory: `_failedResponse`, `_retryAttempt`, and the retry
backoff. A run that failed while the process was alive could be retried by `auto_retry`. A run
that failed because the process died (crash, disconnect, `kill`, OOM) left the session file with
an error response and no way back to it.

Auto-retry also hides its own failures. `_prepareRetry` appends a `context_edit(targetId, null)`
that removes the failed attempt from the model projection while keeping it in raw history. That is
right for a same-process retry; after a restart, nothing says the entry exists or that it can be
re-sent. `--continue` therefore reopened a transcript that ended in an error and had no entry
point to replay it.

## Decision

Every run writes a run record: a `custom` entry with `customType: "run"` holding the run's first
entry, the assistant entry that ended it, `stopReason`, `errorMessage`, the turn count, the retry
attempts it spent, and an outcome of `completed`, `failed`, or `aborted`. The record carries no
model content, so the projection, compaction, and export paths treat it as bookkeeping: it renders
as one dim chat row when the run failed and is ignored by the model.

`/retry` (`AgentSession.retryLastRun()`) replays that failure:

- `findRecoverableRun()` looks at the newest record on the branch. The run is replayable when its
  outcome is `failed` and the recorded assistant entry is still the end of the conversation: its
  raw messages survive, no context edit removed it from the projection, no compaction followed it,
  and the run recorded nothing after it that the model would see.
- A reclaimable failure is rare in practice. Auto-retry omits each attempt it makes, so a run that
  exhausted retries leaves its last failure omitted too: `findRecoverableRun()` finds nothing right
  after the most common failure there is. `findReplayableFailure()` covers that shape (see below).
- A replay whose response is still in the projection starts through a `before_agent_start` trigger,
  `messageType: "continue"`. It adds no message of its own and sets `_failedResponse`, so the
  request repeats the failed turn and virtual-model routing still sees the failure. `_startRun`
  keeps `_failedResponse` for this trigger; a normal prompt still clears it.
- Attempts are charged across processes. The record stores the absolute attempt count, so a replay
  of a session with two spent attempts starts at three instead of resetting the budget to zero.
- A failure auto-retry gave up on is retried as a turn, not as a response. Every attempt that run
  made was omitted from the projection, so replaying the response is impossible by construction:
  `findRecoverableRun()` refuses it on purpose. `findReplayableFailure()` reads the same record but
  accepts that omission, and `retryLastRun()` then drops the omission, clears `_retryAttempt`, and
  starts the run through a `before_agent_start` trigger `messageType: "retry"` that adds no message
  either. The request is the one the omitted attempt would have sent, against a provider that has
  had time to recover, and the retry budget restarts because the run that exhausted it is over.
- `AgentSession` remembers `_lastAssistantEntryId`, the newest assistant entry it persisted. It
  exists because the omission above also takes away the source entry `_recordRunEnd()` would name:
  the run record of the final attempt falls back to this ID instead of recording `undefined`, which
  is what makes the failed run findable at all. A retry that itself failed again replaces it with
  its own response, so `/retry` keeps targeting the newest failure rather than the first one.
- The same entry point is exposed as the RPC command `retry_last_run` and its client method. The
  webui still answers "slash commands are not available" for `/retry`, as it does for every other
  command.

Startup detection (offering a recovery on `--continue`) is deliberately not part of this change:
the acceptance order in the issue puts the explicit command first, and an unasked retry would
spend tokens without consent.

## Alternatives considered

- **Change the persistence rule so a failure is omitted only after a retry succeeds.** This is the
  final step of the issue's plan, and it is what would make most failures replayable. It changes
  what `buildContextEntries` feeds compaction for every session, and it interacts with
  `defer-threshold-compaction` (#115): a failure that stays visible also stays in the token count
  until its retry resolves. Doing it here would make the `/retry` entry point unusable to test
  against existing files, so it waits for real usage data as the issue proposes.
- **Leave the omission in place and repeat the request from the input before the failure.** This is
  what the turn replay first did, on the theory that the provider should not see the failure it is
  being asked to replace. It does not run: with the response omitted, the projection ends with the
  user message, the prompt path takes no message of its own, and `Agent.continue()` refuses to
  start from what is left. Appending a synthetic "try again" message instead would have put words
  in the user's mouth and polluted the transcript for a retry the model can read as a normal turn.
- **Reset the retry budget silently and let the response replay.** Replaying the response sets
  `_retryAttempt` to the attempts the failed run spent, which is what makes a normal `/retry` a
  continuation of the same budget. For a run that already spent the whole budget that number means
  the first `_prepareRetry` gives up again without asking the provider, so the command answers by
  doing nothing. Restarting the budget is the difference between "retry" and "give up twice".
- **A dedicated `run_attempt` entry type.** It would need touching `snapshot`, `projectContextEntry`,
  the tree selector, the HTML export, and JSONL export. A `custom` entry with a payload needs none
  of that: `sessionEntryToContextMessages` already returns nothing for it.
- **Rebuild the failed request from the transcript instead of setting `_failedResponse`.** The
  request projection builds messages from the session file already, so a replay that adds no
  message produces the exact failed request; `_failedResponse` is only what the router and the
  omission path need.
- **Mark a user `Esc` as aborted and a process exit as interrupted, then treat only the latter as
  recoverable.** The plan needs a distinction the session file cannot currently prove: an abort
  path that never ran looks the same as one the process never survived. Records still store an
  `aborted` outcome so a cancelled run is not mistaken for a failure, but both stay unreplayable
  until the cancel path can record which kind of stop it was.

## Consequences

- A session file now holds one `custom` run record per attempt. They are the first entries of that
  type on every branch, so tests that assert exact transcript shapes filter them out; two existing
  tests needed that adjustment.
- A failed run shows `Run failed after N attempts. /retry replays it.` in the chat (an aborted run
  shows `Run was aborted.`, since a cancel is not a failure). The row names no reason: the failed
  assistant message already ends with the same text and a tool call records its own error, so
  repeating it echoed a multi-line provider error twice. The row is registered as an entry renderer
  rather than as a message, so it never reaches a model.
- `/retry` refuses while the agent streams or compacts, and when the newest run did not fail. Both
  errors reach the user as a normal command error rather than a silent no-op.
- Attempt accounting for a replay relies on `_retryAttempt` being restored before the run starts.
  `_startRun` does not reset it, so the value survives into the first `_prepareRetry` call.
- A turn replay leaves the failed response back in the projection: the omission goes away before
  the run starts, so the transcript shows the failure followed by whatever the retry produced. That
  costs context (the failure is text the model did not need to keep) and is the price of the retry
  staying reachable after it runs. Keeping the omission instead made the retry unrepeatable: the
  projection ended with the input that failed, and `Agent.continue()` refused to start from it.
- Coverage: `packages/coding-agent/test/suite/agent-session-retry-session.test.ts` records a completed run, a run whose
  auto-retry gave up, a failure without auto-retry, a replay, a replay that keeps charging
  attempts, a retry of the turn auto-retry gave up on, and a recovery from a session file reopened
  after a restart. `packages/coding-agent/test/agent-session-retry.test.ts` covers the budget
  restarting for the manual retry.
