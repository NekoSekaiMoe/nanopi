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
  exhausted retries leaves its last failure omitted too. What stays replayable is the case this
  issue is about: a failure the process never got to retry, or an attempt that is still the newest
  thing the model saw.
- The replay starts through a new `before_agent_start` trigger, `messageType: "continue"`. It adds
  no message of its own and sets `_failedResponse`, so the request repeats the failed turn and
  virtual-model routing still sees the failure. `_startRun` keeps `_failedResponse` for this
  trigger; a normal prompt still clears it.
- Attempts are charged across processes. The record stores the absolute attempt count, so a replay
  of a session with two spent attempts starts at three instead of resetting the budget to zero.
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
- A failed run shows `Run failed after N attempts: <error>. /retry replays it.` in the chat. The
  row is registered as an entry renderer rather than as a message, so it never reaches a model.
- `/retry` refuses while the agent streams or compacts, and when the newest run did not fail. Both
  errors reach the user as a normal command error rather than a silent no-op.
- Attempt accounting for a replay relies on `_retryAttempt` being restored before the run starts.
  `_startRun` does not reset it, so the value survives into the first `_prepareRetry` call.
- Coverage: `test/suite/agent-session-retry-session.test.ts` records a completed run, a run whose
  auto-retry gave up, a failure without auto-retry, a replay, a replay that keeps charging
  attempts, and a recovery from a session file reopened after a restart.
