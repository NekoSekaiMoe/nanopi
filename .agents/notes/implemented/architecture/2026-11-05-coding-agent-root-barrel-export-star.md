# Agent Note: The coding-agent root barrel is one `export *` per source, and its cost is a number

Status: implemented

## Problem

Issue #506 asked to make `packages/coding-agent/src/index.ts` use `export *`. By the time PR #508
landed, `core/compaction/index.ts` had already been restored to `export *` and pinned with a test
(`packages/coding-agent/test/compaction-barrel-exports.test.ts`): a hand-written whitelist there had silently dropped
`getSummarizationFailure` because only two files import it, and both import the source. The lesson —
a wildcard follows its source files by construction — is what motivates the #506 request.

`src/index.ts` is not an internal barrel. It is the package's public entry (`package.json`
`exports["."]`), and its 546 lines were 45 sources' worth of hand-maintained whitelists. That state
had already rotted in both directions:

- names listed as public that their source no longer exported (`ExecOptions`, `ExecResult`,
  `copyFromClipboard`'s sibling helpers, `main`, `findInitialModel`, ...), invisible to the compiler
  because a named re-export of a missing name is only an error at the barrel;
- two sources declaring the *same name for different things* — `MessageRunRenderOptions` in
  `core/messages/codec.ts` and `core/modules/types.ts`, `CompactionSettings` in
  `core/compaction/compaction.ts` and `core/settings-schema.ts` — which compiled only because
  `index.ts` picked one of them. Under `export *` they are TS2308.

The second problem is the one #506 objects to in its strongest form: a name was publicly ambiguous
and nothing said so.

## Decision

`src/index.ts` is 43 `export *` lines, one per source, and nothing else. It went from 546 lines to
67.

Keeping the public surface from growing is done at the **definition**, not in the barrel: a symbol
that should not be public loses its `export` keyword where it is declared, and gains a paired
re-export in the same module so the package's own files can still reach it by path. `export *`
then cannot carry it out, and no list can drift.

The surface itself is measured, not counted by hand: compile the package with
`--emitDeclarationOnly` (`outDir` outside the repo), then walk `index.d.ts`, following every
`export *` and every `export { ... }` block, and take the set difference across two checkouts. The
numbers this note first carried (320 → 486, 165 added / 38 removed) came from reading the diff by
eye and were wrong in both directions; re-run before quoting a number.

### The four kinds of edit this took

1. **One declaration per name.** `CompactionSettings` lives in `core/settings-schema.ts` now, as
   `CompactionSettingsInput` (the raw, all-optional shape a user writes in `settings.json`) and
   `CompactionSettings` (the same block after defaults are merged, i.e. with `enabled`,
   `reserveTokens`, `keepRecentTokens` required). The copy in `compaction.ts` had drifted behind
   the schema — it never grew `inContext` / `modelOverrides` — so the schema wins.
   `MessageRunRenderOptions` stays as `core/modules/types.ts` has it (that is the module-registration
   contract, published by `modules-api.ts`); the codec-local twin is now
   `MessageCodecRenderOptions` in `core/messages/codec.ts`.
2. **A name reachable through two barrels is still one symbol.** `core/tools/index.ts` forwards
   `createReadTool` from `read.ts`, and `core/sdk.ts` forwards it again from `./tools/index.ts`;
   both paths end at the single declaration, so `export *` over both is unambiguous. An earlier
   version of this note claimed the opposite (a second `createReadTool` declared in
   `core/tools/index.ts`, `export *` dropping the name silently, eleven tool factories therefore
   re-exported by name) and kept that named block "just in case". Deleting the block changes
   nothing: `tsc` stays clean, the measured surface is identical, and
   `packages/coding-agent/test/root-barrel-exports.test.ts` now asserts there is no named block at all.

   The general rule this settles: a *different body under the same name* is TS2308 at the barrel and
   fails the typecheck (that is why `CompactionSettings` / `MessageRunRenderOptions` had to be
   split); "silently dropped" is the JS *runtime* behaviour of `export *`, which never reaches CI
   because `tsc` gets there first.
3. **Internal symbols lose `export` at the definition.** Two passes, 11 names each: public-entry
   internals (`findTurnStartIndex`, `getLastAssistantUsage`, `DEFAULT_COMPACTION_SETTINGS`,
   `BUILTIN_MODULES`, `getPromptsDir`, `getToolsDir`, `findNodePackageDir`,
   `ResolveProjectTrustedOptions`), storage/construction seams (`SettingsStorage`,
   `InMemorySettingsStorage`, `SettingsError`, `SettingsScope`, `SettingsManagerCreateOptions`,
   `CreateModelRuntimeOptions`, `ModelRuntimeAuthOverrides`, `CredentialSynchronizationOperation`),
   file-format details (`QuietStartup`, `ImageSettings`, `POWERSHELL_ARGS`). Each edit is
   `export function foo` → `function foo` plus, only when another file in the package still imports
   it by path, a paired `export { foo }` block at the bottom of the module. The paired block does
   not itself hide anything — `export { foo }` puts the name back in the module's export table;
   what keeps it out of the package root is the missing `export` keyword on the declaration.
4. **Additions were left alone.** A name published by `export *` that no defect motivates hiding
   stays published: tool factories and definitions, module/event types, model routing helpers,
   compaction helpers, session entry *values* (`SessionEntry` stayed private because it is a re-typed
   union that the entry interfaces already describe).

### Where the cost is held

`scripts/check-entry-graphs.mjs` now budgets `packages/coding-agent` `"."`: 707 files, budget 780
(`pi-ai` 336, `coding-agent` 318, `pi-tui` 46, `agent` 7). Root-only files from `./modules` — 601 —
are mostly the provider catalog (270) behind `createAgentSession`'s model resolution. There is no
`forbid` list: the root is a whole agent and always reached `providers/`.

`packages/coding-agent/test/root-barrel-exports.test.ts` pins the shape: 43 `export *` lines, no
named block, and the budget.

## Alternatives considered

**Convert the 36 remaining sources one by one, leaving internal symbols private (the #510 proposal
"B/step 4").** This is what the note previously prescribed, and it does not deliver the stated goal:
a per-source whitelist still has to be edited when that source gains a legitimate export, so the
"names flow automatically" property only holds for sources that are already fully public. The work
of hiding a symbol is the same either way; doing it once and then deleting 546 lines of list is
cheaper than doing it 36 times and keeping 36 lists.

**Publish only the new names that look safe, keep a whitelist for the rest.** Rejected: the count
of "new" names was an artifact of the half-converted state (the same symbol counted once per
source), and it makes the public surface depend on which sources happened to be converted.

**Keep `export *` and drop the collisions silently.** Rejected twice over: at *runtime* `export *`
resolves an ambiguous name by omitting it, but the package is typechecked, and there TS2308 stops
the build. Every collision got a declaration fixed instead. This is also why no named block is
needed as a safety net — a real ambiguity cannot reach CI silently.

**Add a whitelist/source diff check.** Still not done, and now unnecessary: with no whitelist there
is nothing to diff against. The public/private boundary lives in the `export` keywords.

**Hide everything that is not in `modules-api.ts`.** Rejected as a policy: `modules-api.ts` is the
narrow door for *writing a module*, and the root is also the SDK for embedding an agent
(`createAgentSession`, tool factories, model routing, session storage). Most of the surface is
there because that surface is legitimate.

## Consequences

- Gain: the barrel cannot go stale. A new export in any of the 43 sources is public by construction;
  a symbol that must stay private is private where it is defined, which is a reviewable one-line
  diff instead of a list edit nobody can audit.
- Gain: the two ambiguous names are now distinguishable by name, so a caller can no longer pick the
  wrong `MessageRunRenderOptions` by barrels.
- Cost: every name the 43 sources export is public API, and unpublishing any of them later is a
  breaking change. The ones close to the line — `theme` (the singleton), the `config.ts` path
  helpers, the compaction internals — are candidates for removal by dropping the `export` at the
  declaration, not by reintroducing a list.
- `core/messages/codec.ts`'s `MessageCodecRenderOptions` is structurally identical to
  `MessageRunRenderOptions`. They stay separate names because the first is the codec table's and the
  second is what a module registers; unifying them is a follow-up that touches the codec table.

Related: PR #508 (`core/compaction/index.ts`) is the internal-barrel case where a pure `export *` is
correct, because nothing it exposes crosses a package boundary. PR #509 (`@nanopi/pi-tui` root
barrel) reached the opposite conclusion for a public root — keep the whitelist, add the missing
names, reject a whole-package `export *`. The difference is that `pi-tui`'s root is a rendering
surface with a deliberately small contract, while this one already hands out a whole agent;
`packages/tui`'s conclusion stands until its own issue says otherwise.

## Follow-up: actually narrowing the surface (issue #517)

The "internal symbols lose `export` at the definition" step above is not what that edit did. Moving
`export` to a paired `export { ... }` at the bottom of the module leaves the symbol in the module's
export table, and `export *` copies the export table: `setTerminalColors`, the `config.ts` path
helpers and the settings-schema details all still reached the root. Issue #517 measured this against
the emitted `.d.ts`, so the boundary is now the declaration itself.

`src/index.ts` is unchanged. What changed is a handful of declarations across `core/compaction/`,
`core/tools/`, `core/settings-*.ts`, `config.ts`, `utils/` and `modules/`: a name that only exists so a
sibling module or a unit test can reach it is declared without `export`, and the module keeps an
`export { ... }` block at the bottom that the root still sees, because `export *` publishes the
module's export table and a paired block *adds* to it.

The measurement: compile the package with `emitDeclarationOnly`, resolve `index.d.ts`'s
`export *` / `export { }` / `export declare` closure recursively, and diff the two runs. The root went
from 702 names to 691: 11 gone, 0 added.

Removed, by what they were:

- steps inside a public entry point: `findTurnStartIndex`, `getLastAssistantUsage`,
  `DEFAULT_COMPACTION_SETTINGS`, `supportsInContextCompaction`, `appendInContextCompactionRequest`
  and the in-context summary prompts (`compaction.ts`); `BUILTIN_MODULES` (`modules/index.ts`);
  `findNodePackageDir`, `getPromptsDir`, `getToolsDir` (`config.ts`);
  `ResolveProjectTrustedOptions` (`project-trust.ts`)
- storage and construction seams: `SettingsStorage`, `InMemorySettingsStorage`, `SettingsError`,
  `SettingsScope`, `SettingsManagerCreateOptions` (`settings-manager.ts`); `CreateModelRuntimeOptions`,
  `ModelRuntimeAuthOverrides`, `CredentialSynchronizationOperation` (`model-runtime.ts`)
- file-format details: `QuietStartup`, `ImageSettings` (`settings-manager.ts` re-export);
  `POWERSHELL_ARGS` (`utils/shell.ts`)

`DEFAULT_COMPACTION_SETTINGS` is worth a note: it looks like a default a caller would read, but
`compact` takes the merged `CompactionSettings` from `SettingsManager`, so nothing outside the module
uses it.

The regression test reads the sources the root re-exports and asserts each kept-private name has no
top-level `export` declaration there. It reads files rather than the built root so the failure lands
on the edit, not on a stale build.

Two of the four "kinds of edit" above were wrong, and this is where the correction goes:

1. `export *` does not drop an ambiguous name under `tsc`; it is TS2308. The named block for the tool
   factories was never needed — the closure over `core/tools/index.ts` and `core/sdk.ts` reaches the
   same declarations, so no ambiguity exists. Removing it is a separate edit because it changes the
   test's `named` expectation, not because the code disagrees.
2. The paired-re-export trick does not hide anything, which is the whole point of this follow-up.
