# Agent Note: getLoadedResources() extension API and the /status resource listing

Status: implemented

## Problem

The startup page rendered the loaded-resource listing
(`[Context]`/`[Skills]`/`[Prompts]`/`[Extensions]`) between the welcome box
and the chat, so every session opened with an informational block the user
wants gone. But `/status` — a built-in extension command — could not take
over the listing: `ExtensionCommandContext` exposes no resource-loader data
(`getSystemPromptOptions()` covers context files and skills only, and nothing
covers prompts or extensions), and the formatting lived as ~15 private
methods on `InteractiveMode`, unreachable from extension code.

## Decision

- `ExtensionContext` (all contexts, not just commands) exposes
  `getLoadedResources(): LoadedResources` — a snapshot of
  `contextFiles` (system prompt source, appended sources, agents files, in
  load order), `skills` (`name` + path + sourceInfo), `prompts`
  (`name` without the slash), and `extensions` (hidden built-in inline
  extensions excluded). `ExtensionContextActions.getLoadedResources` is
  optional with an empty-snapshot default so SDK-style embedders that never
  bind a resource loader keep working (`runner.ts` owns the default).
- The label formatting moved to `src/core/resource-listing.ts` as pure
  functions (`formatContextPath`, `getShortPath`,
  `getCompactExtensionLabels`, `getDisplaySourceInfo`, …) taking `cwd`/`home`
  parameters instead of reading `InteractiveMode` state.
  `InteractiveMode.formatDiagnostics` keeps using them for the startup
  diagnostics; `/status` uses them for the listing.
- `/status` (`builtin-commands/status.ts`) renders the sections below its
  rows: compact comma-separated names, sorted like the old collapsed startup
  lists (context files keep load order, cwd-relative), wrapped to the dialog
  width by `wrapStatusText`. Outside TUI the notify fallback includes them.
- `InteractiveMode.showLoadedResources()` now renders diagnostics only
  (skill/prompt/extension conflicts and errors; theme conflicts existed until
  the theme system was removed — see
  [remove the theme system and the /reload command](../simplification/2026-10-13-remove-theme-system-and-reload-command.md));
  the listing branches, `ExpandableText`, and the scope-group/compact-label
  helpers are deleted.

Related: [builtin-commands home](../feature/2026-10-11-builtin-commands-and-codex-compaction.md)
and [Codex welcome/footer/status reskin](../feature/2026-10-11-codex-welcome-footer-status.md),
which this note extends.

## Alternatives considered

- Reuse `getSystemPromptOptions()` for the listing: rejected — it cannot see
  prompts or extensions, and stretching it to carry them would overload a
  system-prompt contract with UI listing concerns.
- Pass the `ResourceLoader` itself into the extension context: rejected — it
  hands extensions mutation-adjacent surface (diagnostics, theme registries)
  for what is a read-only snapshot need; the snapshot type also stays stable
  for third-party code.
- Keep the startup listing behind `--verbose`/`quietStartup` gating:
  rejected — the user asked for a clean startup page; the information stays
  one `/status` away and `quietStartup` keeps gating the model-scope line.

## Consequences

- Benefit: the startup page shows only actionable warnings; `/status` is the
  single place for "what is loaded"; extensions can build richer status UIs
  on `getLoadedResources()`.
- Cost: the Ctrl+O expanded (scope-grouped, full-path) listing form is gone —
  only the compact form survives. Paths remain available through
  `/config`-style inspection or the resource-loader diagnostics.
- Tests: the compact-label suite moved to `test/resource-listing.test.ts`
  against the pure functions; `showLoadedResources` tests now cover
  diagnostics-only rendering; `collectStatusSections` has coverage in
  `test/status-command.test.ts`.
