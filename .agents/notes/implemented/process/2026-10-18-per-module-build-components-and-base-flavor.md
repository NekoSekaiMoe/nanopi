# Agent Note: per-module build components and the base/minimal flavors

Status: implemented

## Problem

`buildconfig.json` had two flavors (`full`, `minimal`) and one switch that could
drop a module: `modes`, which aliased the whole `@nanopi/pi-extra` package to an
inert stub. Everything else was compiled in unconditionally, so a small build
still shipped ask-lite, mcp-lite, the LSP client, subagent orchestration, the UI
extra, and todo-lite: their handlers, tools, and commands ran, just with
peripheral assets missing.

Two more gaps came out of the same conversation (issue #34):

- The tool set was fixed. `minimal` meant "core CLI without peripherals", not
  "the model can only run shell commands". A deployment that wants the model to
  work through bash had to rely on settings, `--tools`, or the extra module's
  run-mode interception, all of which a resumed transcript or another module
  could undo.
- Extension and embedder code reached into package internals because the SDK
  entry did not export what it composed with (`filterToolDefinitions`, the
  settings storage types, the path and shell helpers, build-component guards).

## Decision

**Modules are build components.** Every entry in `BUILTIN_MODULES`
(`packages/coding-agent/src/modules/index.ts`) is a `module/<name>` component,
and `buildconfig.json` lists its source path in the top-level `moduleBundles`
map. Bundle and single-file builds derive the import specifier from that path
(compiled `.js`, relative to the modules barrel and to the src root) and alias
the disabled ones to a generated stub that exports an inert factory
(`scripts/build-modules.mjs`). The list of names is parsed out of the barrel by
`scripts/module-registry.mjs`, so no second copy exists, and
`validateFlavorModules` fails the build when a module, its component, or its
`moduleBundles` entry is missing on either side.

`BUILTIN_MODULES` stays the static registry (hidden modules included, so a
`--modules` list still parses); `enabledModules()` returns the subset this build
carries and is what `main()` hands to the resource loader.

**The tool set is a component with values.** `toolset` selects one of the
`toolsetComponents` names (`standard`, `bash`) instead of acting as a switch. A
bash-only build filters the base tool definitions to `bash`/`powershell` at
session load (`filterToolDefinitions`), defaults the active loadout to the shell
tools, and blocks any other call in the `beforeToolCall` hook. The extra module's
run modes keep working; they no longer matter because the other tools do not
exist.

**Flavors.** `base` is the former `minimal` (core CLI, every module except the
bundled extras, standard tool set). `minimal` is `base` plus `toolset: "bash"`.
The former `modes` switch is gone; `module/extra` replaces it, with the same
stub behavior for its package specifier.

**Exports.** The SDK entry re-exports the helpers extensions were reaching for,
so downstream code composes through `@nanopi/pi-coding-agent` instead of deep
imports.

## Alternatives considered

- **Runtime filtering without stubbing** (register every module, then filter in
  `enabledModules()`). Smallest change, and it is what `enabledModules()` alone
  would do, but it keeps every module's code, commands, and tool schemas in the
  bundle and the single-file artifact: the point of a small flavor is not just
  fewer registrations but a smaller artifact and a shorter surface. The stub is
  what makes the code physically absent.
- **A per-module component per vendored package** (e.g. `extra/ask-lite`
  alongside `module/ask-lite`). Two names for one thing; the module name already
  is the unit that registry, `--modules`, and the barrel agree on.
- **Making `minimal` a runtime mode of the extra module** (what the `minimal`
  run mode already does). Rejected because it is a session-police arrangement: a
  module can call `setActiveTools()`, a transcript can restore a wider loadout,
  and the tool definitions still ship. A build flavor has to be enforced where
  the tools are registered.
- **Keeping `minimal` as the peripheral-less flavor and adding `bash` as a third
  name.** The user's decision was the opposite mapping: `base` names the
  peripheral-less baseline, `minimal` names the shell-tool build. Followed as
  asked; it also reads better, since `minimal` is now the smallest one.

## Consequences

- A flavored build now has an extra failure mode the build scripts check
  mechanically: `validateFlavorModules` refuses a build when the module list,
  `module/*` components, and `moduleBundles` disagree.
- Disabled modules leave string references behind (guideline text mentioning
  `ask_user_question`, the `--modules` parser), but no code: the stub replaces
  the import, and `splitting: false` keeps a shared chunk from pulling it back.
- The bash-only build gates on the shell tool names, not on a full permission
  model. A deployment that needs write control still configures the extra
  module's permission gate; the tool set only removes the tools.
- `pnpm run check` stays flavor-independent, and the published npm packages stay
  `full`.
- CI publishes `nanopi-base.js` alongside `nanopi.js` and `nanopi-minimal.js`.

Related: [build flavors](2026-10-11-build-flavors-buildconfig.md) (the flavor
mechanism this narrows), [packages/extra modes](../architecture/2026-10-12-packages-extra-modes-permissions.md)
(the module that used to be the only switchable one).
