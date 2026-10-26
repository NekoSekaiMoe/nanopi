# Agent Note: Diagnostic bundles ride on `NANOPI_DEBUG`, not a command

Status: implemented

## Problem

`/bug` was removed in the same series (issue [#211](https://cnb.cool/shinytale/nanopi/-/issues/211)):
its collector built a zip addressed to a Radius gateway that no longer exists. The
command went; the collection it did is still what a maintainer asks for after a bug
report — nanopi version, OS, model and provider configuration, loaded modules,
settings, the failed assistant turns, the transcript.

Two things were wrong with collecting it on demand, and both are the reason the
command could not simply be renamed:

- A report is written after the failure. By then the process is gone, and the state
  that explains the failure (a session that crashed, a turn that died on a provider
  error) is only recoverable if something already wrote it down.
- A prompt at that moment is worse than none. The user is closing a broken session;
  asking them to answer "include the transcript?" produces an empty directory
  exactly when the bundle mattered.

Debug mode already exists for these sessions. `NANOPI_DEBUG=1` makes nanopi append
`nanopi-debug.log` to the agent dir (see
[the debug log note](2026-10-23-runtime-debug-log-file.md)). That log says what a
session cost; it cannot say what broke.

## Decision

`NANOPI_DEBUG=1` writes a diagnostic bundle, twice per interactive session: once at
startup and once at exit. No prompt, no command, no upload.

- The destination is `<agent dir>/diagnostics/<utc timestamp>-<startup|exit>/`
  (`writeDiagnosticBundle`). Timestamped directories because a debug run is a series
  of sessions, and the exit bundle must never overwrite the startup one — the pair
  is what shows what the session did.
- A bundle is the loose files plus `bundle.zip` of the same content: `diagnostics.json`
  (environment, model, provider, modules, settings), `report.json` (failed assistant
  turns, recorded crashes), `session.jsonl` (the current branch), `debug.log` (the
  tail of the debug log, capped at 512 KiB). Loose files stay readable without
  unzipping; the zip is what gets attached to an issue.
- Every URL, header value, and settings field that looks like a credential is
  redacted before it reaches disk (`redactUrl`, `redactJsonValue`). Tracking and device
  ids are dropped with the settings. The transcript is not redacted — it is the
  user's own conversation, and rewriting it would make the bundle lie.
- The exit bundle is written after the TUI stops and before `process.exit`, awaited,
  and its directory is printed to stdout. Written after the screen is restored so the
  notice survives; awaited because the bundle holds the only record of the session
  that just closed.
- Filesystem work is best-effort at every step. A debug diagnostic must never be the
  reason a session fails to start or exit.

## Alternatives considered

- Bring back a `/diagnose` command: rejected — it collects at the wrong time (after
  the failure, if at all) and needs the user to remember it exists. Its whole value
  is that it already ran.
- Prompt for consent when debug mode starts, the way `/bug` did: rejected — the
  consent would be for a bundle that mentions `NANOPI_DEBUG=1` and no upload. A user
  who types that flag has already opted into the data landing on their own disk.
- Upload the bundle to the GitHub tracker: rejected — there is no receiver without a
  token, and the `gh` path is what `/share` already does for sessions. The bundle is
  a file the user attaches.
- Only write the exit bundle: rejected — a session that crashes, or a terminal that
  dies, never reaches the exit path, and that is exactly the session worth having.
- Write only `bundle.zip` and skip the loose files: rejected — reading a transcript out
  of a zip to answer "which model, which error" is friction on the worst day, and the
  disk cost is a few hundred kilobytes in a directory the user asked for.
- Reuse `crashes.json` as the bundle's crash section instead of copying it: the copy is
  already there — `report.json` carries the records, so the diagnostics outlive the
  crash log's 5-record cap and the `clearCrashLog()` callers.

## Consequences

- Benefit: a debug session leaves an artifact that survives a crash and can be
  attached to an issue without assembling anything by hand; a session that ran fine
  costs one directory per start and exit.
- Cost: the transcript is written twice per session (session file plus bundle) and is
  not redacted, so the agent dir inherits the session's sensitivity. Nothing prunes
  `diagnostics/`; a user who leaves the flag on accumulates directories and deletes
  them by hand.
- `fails open`: a broken filesystem path returns `undefined` and the session proceeds.
  The tradeoff is that "no bundle" and "bundle failed" look the same until the user
  checks the directory.
- Testing: `test/diagnostic-bundle.test.ts` covers redaction, metadata shape, failed-turn
  filtering, the loose-files layout, phase labelling, and the debug log tail.
