# Agent Note: Built-in /init, /context, /exit and Codex-style default compaction

Status: implemented

## Problem

The `/init` and `/context` commands and Codex-style compaction lived in two
vendored extras (pi-extra-cmd, pi-codex-compact). They had become core UX
rather than optional peripherals: the commands are small, dependency-free
product features, and the compaction style was the wanted default for every
session and every flavor. Keeping them as extras also meant duplicate
behavior risk if they were ever built in, and no coverage in the first-party
suite.

## Decision

Both are built in as inline extensions under `src/extensions/`, following the
existing llama.cpp pattern (`builtInExtensions` in `src/extensions/index.ts`):
`builtin-commands` registers `/init` and `/context` through the extension API,
and `codex-compaction` drives every compaction via the `session_before_compact`
hook — handoff-framed summary (`SUMMARY_PREFIX` from Codex), verbatim retention
of the last 20,000 tokens of user messages across the cut point (the cut walks
backwards to a user-message budget, never snapping onto tool-result-only
entries), rolling file lists, and Codex's post-compaction accuracy warning as
a TUI-only transcript row.

The extension API was chosen over porting into `core/compaction/`: the hook
already has full control over manual/threshold/overflow compaction, the
session machinery (entries, token accounting, SDK/RPC surface) stays
untouched, and the port stays near-verbatim from the maintained packages.
Any surprise (no model, auth failure, empty summarize set) returns
`undefined`, so the default compaction remains the safety net — there is no
disable switch (user decision).

`/quit` is renamed to `/exit` (BUILTIN_SLASH_COMMANDS, the interactive
handler, docs); no alias remains, which also frees `/quit` for extension
registration. The two extras are deleted along with their `buildconfig.json`
components, dropping bundled extras to nine.

## Alternatives considered

- **Port the compaction into `core/compaction/` directly.** More invasive:
  the hook path keeps the session format, SDK, and auto-compaction triggers
  untouched while changing the same behavior; the diff stays reviewable.
- **Keep the extras and enable them by default.** Rejected (user decision):
  built-in means every flavor (including minimal) gets them, they load
  without jiti, and the first-party suite covers them.
- **`/exit` as an alias next to `/quit`.** User chose a swap; the repo rule
  is no backward compatibility unless requested.
- **Configurable compaction style (setting or env kill switch).** User
  decision: one default, no escape hatch; the failure-policy fallback is the
  only recovery path.

## Consequences

- Every session in every flavor compacts Codex-style when the model resolves
  auth; otherwise (including the faux-provider test suite) the default
  compaction runs — existing compaction tests pass unchanged because the
  faux provider fails the auth lookup.
- New first-party tests: `test/codex-compaction.test.ts` (retention plan,
  boundary handling, summary framing) and `test/builtin-commands.test.ts`
  (token formatting, part capping, used-token reconciliation, breakdown
  collection).
- The ported code is now maintained in-tree; upstream pi-extra-cmd /
  pi-codex-compact changes must be applied here manually.
- `/context` keeps its upstream attribution (ported from
  minuque/pi-cc-extensions, MIT) and the codex prompts stay verbatim from
  openai/codex.

Related: [bundled extras](2026-10-11-bundled-extras.md) (the mechanism the
extras rode on; both packages left it), [build flavors via
buildconfig.json](../process/2026-10-11-build-flavors-buildconfig.md).
