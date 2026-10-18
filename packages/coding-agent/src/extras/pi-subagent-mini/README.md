# pi-subagent-mini

Lean single-tool subagent extension for [pi](https://github.com/earendil-works/pi).
**Zero runtime dependencies** — no node_modules needed.

One tool (`subagent`), four actions, ~296 prompt tokens (vs 1,563 for the
5-tool suite it replaces):

| action | what it does |
| --- | --- |
| `spawn` | Start an isolated child session (`--mode json -p --no-session`) with a tool allowlist; returns a `jobId` immediately |
| `wait` | Block until done (default 120s, `waitSec` to change), return the report |
| `status` | State + report tail |
| `kill` | Stop it |

On completion a `subagent-complete` steering message delivers the report as a
**new turn** — the main conversation only ever sees the final report, never the
child's intermediate work.

## Parameters

- `action`: spawn / wait / status / kill
- `task` (spawn): the brief, written as `GOAL` / `CONTEXT` / `EXPECTED OUTPUT` / `STOP RULES`
- `description` (spawn): one-line scope for status and the notification (defaults to the GOAL line)
- `waitSec` (wait): how long to block; a timeout returns the job as still running
- `tools` (spawn): comma list, default `read,bash,grep,find,ls`; add `write,edit` only when the child should modify files
- `cwd` (spawn): working directory (default: session cwd)
- `model` / `timeoutSec` (spawn): optional; timeout default 600s
- `jobId` (wait/status/kill)

Design trade-offs (deliberate, to stay lean): no agent registry, no mailbox —
follow-up questions are handled by spawning a new subagent with context from
the previous report (stated in the tool description so the model knows).
Max 4 concurrent subagents, and only one of them may write at a time: `bash`
makes any child writable in practice, so writers are serialized rather than
told apart file by file. To write in parallel, give each subagent its own tree
with `git worktree add <dir> -b <branch>` and pass `cwd` to spawn, then merge
the branches yourself — a prompt guideline, not a mechanism, so nothing
enforces it. Recursion is prevented at the execution layer (the child's module
set has no subagent tool) and at the prompt layer (the description opens by
saying the subagent is not the main agent).

## Notes

- Children start from their own prompt (~1.7k tokens) and keep no session
  (`--no-session`), with `--no-skills --no-prompt-templates`. `AGENTS.md` stays
  on: the child has `bash` and can commit, so the repository rules (no `git add
  -A`, `pnpm run check`, no emoji) are the cheapest thing to keep.
- The notification clips a long report head-and-tail so the conclusion survives;
  the full text goes to the session as a `subagent-job` entry, which is also how
  `/compact` and a restart learn which subagents ran.
- Child tools default to the parent's declared order, matching its `<rules>`
  block. Tool order is the tail of the Anthropic cached prefix, so a different
  order means a full cache miss on every child turn.
- Uses the same subprocess mechanism as the big suites (`--mode json` NDJSON
  events), just without the orchestration/TUI/config layers.
- Interactive mode shows a live `subagent-async` widget (one row per running
  job, refreshed every second). It deliberately reuses the same widget key as
  `pi-subagents`, so [`pi-ui`](../pi-ui/)'s flat skin picks these jobs up too.

## Usage

```bash
pi -e ./src/index.ts
```

## License

MIT
