# Agent Note: Footer badges through the status channel, not a custom footer

Status: implemented

## Problem

Two TUI features were silently invisible: the extra module's red `yolo` / green
`plan` mode badges and the yellow `shell` label. Both existed in code and never
showed up.

`ctx.ui.setFooter()` is a replacing, single-slot setter
(`InteractiveMode.setExtensionFooter` disposes the previous footer). The
`extra` module installed a badge footer from its `session_start` handler, and
pi-ui — registered later in `BUILTIN_MODULES`, so its handler runs later —
replaced it with its own toolbar that renders neither badges nor the shell
label. Last writer wins; the first writer's footer is disposed. The same
replacement also orphaned the built-in `FooterComponent`'s yellow `shell`
label: `updateEditorBorderColor` calls `footer.setShellMode(...)` on the
detached built-in instance while pi-ui's footer is the one on screen.

The status channel (`ctx.ui.setStatus(key, text)` →
`FooterDataProvider.getExtensionStatuses()`) already had producers (pi-rewind
checkpoints, pi-fake-codex hook states) but no consumer: the built-in footer
intentionally hides statuses and pi-ui's footer ignored its `footerData`
parameter.

## Decision

Badge and label data travel through channels that survive footer replacement;
exactly one footer — pi-ui's — renders them.

- The extra module never calls `setFooter()`. It pushes colored badge text via
  `ctx.ui.setStatus("mode", modeBadgeText(engine, ctx.ui.theme))` on
  `session_start` and on every engine change (`engine.subscribe`). Producers
  embed ANSI colors themselves with `theme.fg()` — the convention pi-rewind
  already established; coloring is not the renderer's business.
- pi-ui's toolbar line renders `footerData.getExtensionStatuses()` values
  right-aligned, followed by the yellow `shell` label
  (`theme.fg("bashMode", "shell")`). The right side wins: the usage line
  truncates first, and the suffix is dropped only when it cannot fit at all.
- Shell mode is detected per render via
  `ctx.ui.getEditorText().trimStart().startsWith("!")`, mirroring
  `isBashMode` in interactive-mode. Editor input always triggers a repaint,
  so the label tracks typing with no new plumbing (the
  `ReferenceUiState.shellMode` field it replaces was never set by anyone).
- `InteractiveMode.setExtensionStatus` requests a render so status changes
  repaint immediately.

Supersedes the status-channel rejection in
[packages-extra-modes-permissions](../architecture/2026-10-12-packages-extra-modes-permissions.md)
(its "no color control" premise predates the producer-colors convention) and
the "extension statuses hidden" pi-ui claim in
[codex-welcome-footer-status](../feature/2026-10-11-codex-welcome-footer-status.md).

## Alternatives considered

- Reorder modules so `extra` installs its footer after pi-ui: still
  last-writer-wins; any other footer-shipping module recreates the race.
  Rejected.
- Make `setFooter` compose (decorate instead of replace): an API contract
  change rippling through interactive-mode, the module docs, and rpc-mode for
  one bug. Rejected for this fix.
- Detect `yolo`/`plan` labels inside pi-ui and color them there: pi-ui would
  own another module's vocabulary. Rejected; producer-embedded colors keep
  the status channel generic.

## Consequences

- Benefit: the status channel is end-to-end functional for every producer
  (mode badges, rewind checkpoints, hook states), independent of which footer
  is installed; the shell label works under pi-ui.
- Cost: statuses render only if the installed footer chooses to render them
  (the built-in `FooterComponent` still hides them by design); producers that
  want colors call `theme.fg` at push time, so a mid-session theme switch
  leaves stale colors in already-set texts until the next push.
- Testing: `packages/extra/test/badges.test.ts` (badge labels and text),
  `packages/coding-agent/test/pi-ui-footer-status.test.ts` (right alignment,
  truncation order, ANSI passthrough).
