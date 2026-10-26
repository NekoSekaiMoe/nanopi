# pi-subagent-mini

Lean single-tool subagent extension for [pi](https://github.com/earendil-works/pi).
**Zero runtime dependencies** — no node_modules needed.

One tool (`subagent`), five actions:

| action | what it does |
| --- | --- |
| `spawn` | Start an isolated child session with a tool allowlist; returns a `jobId` immediately |
| `wait` | Block until done (default 120s, `waitSec` to change), return the report |
| `status` | State + report tail |
| `kill` | Stop it |
| `continue` | Run another round on the same child session, so the child keeps its transcript |

On completion a `subagent-complete` custom message carries the report. It starts a
new turn only when the parent session is idle; while a turn runs it is queued onto
it, so a report never races the run that is settling.

## Parameters

- `action`: spawn / wait / status / kill / continue
- `task` (spawn/continue): the brief, written as `GOAL` / `CONTEXT` / `EXPECTED OUTPUT` / `STOP RULES`
- `description` (spawn/continue): one-line scope for status and the notification (defaults to the GOAL line)
- `waitSec` (wait): how long to block; a timeout returns the job as still running
- `tools` (spawn/continue): comma list, default `read,bash,grep,find,ls`; add `write,edit` only when the child should modify files
- `cwd` (spawn): working directory (default: session cwd); rejected together with `isolated`
- `model` / `timeoutSec`: optional; timeout default 600s per attempt
- `dependsOn` (spawn): job ids that must settle first; their reports are pasted into the dependent's brief
- `dependsOnTimeoutSec` (spawn): stop waiting for `dependsOn` after this many seconds and report the
  job as blocked, naming the dependencies that never settled; unset waits indefinitely
- `isolated` (spawn/continue): give the job its own git worktree
- `onFailure`: `"report"` (default) or `"retry"`, capped at 3 attempts
- `jobId` (wait/status/kill/continue)

## What the code enforces

**Sessions, not one-shot briefs.** A child runs with its own session file and the
tool records the session id. `continue` appends a new round to that same
transcript with the previous report as context, so a follow-up brief only has to
say what changed instead of restating everything the child already knows.

**Dependencies.** `dependsOn: ["sa-1", "sa-2"]` means the job does not start until
both settle, and that it starts with their reports already in its brief:

```
Context from the jobs this one depends on (verbatim reports):
### sa-1 (completed)
<report>

### sa-2 (completed)
<report>

Task: <the brief that was spawned>
```

That assembly is the same one `continue` uses for the previous round, moved to
where the edges are known, so a dependent never depends on the main agent copying
a report by hand (and nothing silently loses a report's tail).

A dependency that failed, timed out, was killed, or was interrupted blocks the
dependent (`blocked`, reported like any other outcome) rather than letting it run
on missing work. That includes a dependency killed by `kill` or by the session
shutdown, which used to leave its dependents queued forever. An unknown id is
refused at spawn time, because it can never settle. The main agent does not poll
for this.

Waiting on a dependency that never settles is bounded by `dependsOnTimeoutSec`,
not by a status: an unsettled dependency has produced nothing to draw a
conclusion from, so waiting indefinitely is the wrong default for a job that
might be blocking a whole chain.

**Restarts.** Every archived job records its `dependsOn` edges, so a restored
session rebuilds the graph instead of a bag of reports. A job archived as
`queued`/`blocked` is re-queued and runs (with its dependency reports injected);
a job archived as `running` lost its process with the parent, so it becomes
`interrupted` — settled, not succeeded — and its dependents see the failure
instead of waiting forever.

**Isolation.** `isolated: true` runs `git worktree add <dir> -b subagent/<jobId>`
next to the repository root and passes that directory as the child's cwd. The
directory is derived by the tool, so no model copies a path. On `completed` the
branch is merged back and the tree removed; on failure, kill, or timeout the tree
is removed and the branch dropped.

**Failure semantics.** `onFailure: "retry"` reruns a failed attempt with the
failure text prepended to the brief, up to 3 attempts in total. The limit is a
constant; a brief cannot raise it.

An exit on a signal is `killed`, not `completed`: `kill -9`, the OOM killer and a
container restart all reach the parent as `code === null` plus a signal, and
treating that as success published a report for a child that never finished. A
signal nobody here sent (`SIGKILL`/`SIGTERM`/`SIGINT`/`SIGHUP`) is `killed`; a
crash signal (`SIGSEGV`, `SIGABRT`) stays `failed`. A killed job is never
retried — it was killed by something outside its own work, and the second attempt
mostly buys the same ending.

`status` describes the latest attempt only, so every attempt's ending is kept in
`attemptLog` (also archived). `action: "status"` prints it:

```
subagent sa-3: completed (…, attempt 2/3)
attempts: attempt 1 timeout: timed out after 600s
```

**Concurrency.** Max 4 concurrent subagents. Only one of them may write to the
shared tree at a time: `bash` makes any child a potential writer, so writers are
serialized unless they are isolated, which gives each one its own tree.

## Notes

- Children keep `AGENTS.md` (`--no-skills --no-prompt-templates` are the only
  discovery flags turned off): the child has `bash` and can commit, so the
  repository rules (no `git add -A`, `pnpm run check`, no emoji) are the cheapest
  thing to keep.
- The notification clips a long report head-and-tail so the conclusion survives;
  the full text goes to the session as a `subagent-job` entry, which is also how
  `/compact` and a restart learn which subagents ran and which session each one owns.
- Child tools default to the parent's declared order, matching its `<rules>`
  block. Tool order is the tail of the Anthropic cached prefix, so a different
  order means a full cache miss on every child turn.
- Uses the same subprocess mechanism as the big suites (`--mode json` NDJSON
  events), just without the orchestration/TUI/config layers.
- Interactive mode shows a live `subagent-async` widget (one row per active job,
  refreshed every second). It deliberately reuses the same widget key as
  `pi-subagents`, so [`pi-ui`](../pi-ui/)'s flat skin picks these jobs up too.

## Usage

```bash
pi -e ./src/index.ts
```

## License

MIT
