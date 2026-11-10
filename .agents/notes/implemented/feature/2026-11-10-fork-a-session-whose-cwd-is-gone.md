# Agent Note: Fork a session whose stored cwd is gone

Status: implemented

## Problem

A session file records the working directory it was created in. When that
directory is renamed or deleted, opening the session throws
`MissingSessionCwdError`, and interactive mode answered with a single question:
continue in the current directory, or cancel. Continuing runs the session here
for this process only — the header keeps the dead path — so the same question
comes back on the next resume, forever.

`/import` made it worse. `importFromJsonl` copied the file into the session
directory *before* checking the stored cwd, then threw. The copy stayed, and a
retry wrote `s-1.jsonl` next to the `s.jsonl` that already carried the same
session ID.

## Decision

The prompt becomes three choices: `Continue`, `Fork`, `Cancel`. `Fork` copies
the session into the current directory through `SessionManager.forkFrom`, which
writes a new header (new ID, `cwd` = current directory, `parentSession` = the
old file) and appends the source entries. The dead path is gone from the new
session, so the next resume does not ask.

`AgentSessionRuntime.switchSession()` takes `cwdOverride` plus `forkToCwd`, and
`importFromJsonl()` takes the same option object instead of a bare cwd override
string; a shared `openSessionFor()` picks `SessionManager.open` (override the
cwd in memory) or `SessionManager.forkFrom` (record it on disk). The import path
also removes its own copy when the session cannot be opened, so a cancelled
import leaves the session directory unchanged.

Startup (`--session`, `--resume`), `/resume`, `/import`, and
`ctx.switchSession()` all go through the same three-way prompt at their own
layer: `main.ts` has no session runtime yet, the interactive mode catches the
error at the two command sites.

## Alternatives considered

- Rewrite the header of the existing session in place: rejected — it edits a
  file the user may still want to open from the old path on another machine, and
  it silently changes the ID a session is addressed by.
- Store the `Continue` choice in settings so the next resume stops asking:
  rejected — a global keyed on "this session's path is gone" is not something a
  user can undo, and the path may come back (an unmounted disk, a renamed
  checkout).
- Fork on the extension-facing `switchSession()` only and leave `/import` alone:
  rejected — `/import` is the path that produced the duplicate files in the
  first place.

## Consequences

Forking duplicates the transcript on disk once per rescue; the old file stays
where it was, now only reachable as the new session's `parentSession`. A session
that is forked twice from the same dead path produces two independent copies.

`importFromJsonl()` changed from `(inputPath, cwdOverride?: string)` to
`(inputPath, options?)`. It is an internal runtime API, so no deprecation shim
was kept.
