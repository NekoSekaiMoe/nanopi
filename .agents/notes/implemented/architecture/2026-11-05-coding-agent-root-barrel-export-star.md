# Agent Note: The coding-agent root barrel is one `export *` per source, and its cost is a number

Status: implemented

## Problem

Issue #506 asked to make `packages/coding-agent/src/index.ts` use `export *`. By the time PR #508
landed, `core/compaction/index.ts` had already been restored to `export *` and pinned with a test
(`test/compaction-barrel-exports.test.ts`): a hand-written whitelist there had silently dropped
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

`src/index.ts` is 43 `export *` lines, one per source, plus one named re-export. It went from 546
lines to 69.

Keeping the public surface from growing is done at the **definition**, not in the barrel: a symbol
that should not be public loses its `export` keyword where it is declared, and gains a paired
re-export in the same module so the package's own files can still reach it by path. `export *`
then cannot carry it out, and no list can drift.

The resulting public surface is 486 names over 43 sources, up from 320: 165 added, 38 removed, and
one (`createReadTool`) that used to be `core/tools`' and is now the same factory `core/sdk.ts` always
meant.

### The four kinds of edit this took

1. **One declaration per name.** `CompactionSettings` lives in `core/settings-schema.ts` now, as
   `CompactionSettingsInput` (the raw, all-optional shape a user writes in `settings.json`) and
   `CompactionSettings` (the same block after defaults are merged, i.e. with `enabled`,
   `reserveTokens`, `keepRecentTokens` required). The copy in `compaction.ts` had drifted behind
   the schema — it never grew `inContext` / `modelOverrides` — so the schema wins.
   `MessageRunRenderOptions` stays as `core/modules/types.ts` has it (that is the module-registration
   contract, published by `modules-api.ts`); the codec-local twin is now
   `MessageCodecRenderOptions` in `core/messages/codec.ts`.
2. **A name exported twice with different bodies stays named.** `core/tools/index.ts` re-exports
   `createReadTool` from `read.ts` *and* declares its own `createReadTool(cwd, options)`;
   `core/sdk.ts` re-exports the first one. `export *` over both barrels drops the name, so
   `index.ts` names the eleven tool factories from `./core/tools/index.ts` explicitly. That block is
   the same one it had before; it does not grow when a source does.
3. **Internal symbols lose `export` at the definition.** 38 names were removed this way (theme
   terminal negotiation, session-file entry types, RPC wire types, settings-schema details, path
   helpers). Each edit is `export function foo` → `function foo` plus a paired
   `export { foo }` block at the bottom of the module, so intra-package imports keep working and
   only the package root changes.
4. **Additions were left alone.** A name published by `export *` that no defect motivates hiding
   stays published: tool factories and definitions, module/event types, model routing helpers,
   compaction helpers, session entry *values* (`SessionEntry` stayed private because it is a re-typed
   union that the entry interfaces already describe).

### Where the cost is held

`scripts/check-entry-graphs.mjs` now budgets `packages/coding-agent` `"."`: 707 files, budget 780
(`pi-ai` 336, `coding-agent` 318, `pi-tui` 46, `agent` 7). Root-only files from `./modules` — 601 —
are mostly the provider catalog (270) behind `createAgentSession`'s model resolution. There is no
`forbid` list: the root is a whole agent and always reached `providers/`.

`packages/coding-agent/test/root-barrel-exports.test.ts` pins the shape: 43 `export *` lines, the one
named block, and the budget.

## Alternatives considered

**Convert the 36 remaining sources one by one, leaving internal symbols private (the #510 proposal
"B/step 4").** This is what the note previously prescribed, and it does not deliver the stated goal:
a per-source whitelist still has to be edited when that source gains a legitimate export, so the
"names flow automatically" property only holds for sources that are already fully public. The work
of hiding a symbol is the same either way; doing it once and then deleting 546 lines of list is
cheaper than doing it 36 times and keeping 36 lists.

**Publish only the 267 new names that look safe, keep a whitelist for the rest.** Rejected: the
267 was always an artifact of the half-converted state (the same symbol counted once per source),
and it makes the public surface depend on which sources happened to be converted. The number that
matters is the surface itself, 486.

**Keep `export *` and drop the collisions silently.** `export *` resolves an ambiguous name by
omitting it, which is the failure mode #506 exists to kill, except here it also fails `tsc`. Every
collision got a declaration fixed instead.

**Add a whitelist/source diff check.** Still not done, and now unnecessary: with no whitelist there
is nothing to diff against. The public/private boundary lives in the `export` keywords.

**Hide everything that is not in `modules-api.ts`.** Rejected as a policy: `modules-api.ts` is the
narrow door for *writing a module*, and the root is also the SDK for embedding an agent
(`createAgentSession`, tool factories, model routing, session storage). Most of the 486 are there
because that surface is legitimate.

## Consequences

- Gain: the barrel cannot go stale. A new export in any of the 43 sources is public by construction;
  a symbol that must stay private is private where it is defined, which is a reviewable one-line
  diff instead of a list edit nobody can audit.
- Gain: the two ambiguous names are now distinguishable by name, so a caller can no longer pick the
  wrong `MessageRunRenderOptions` by barrels.
- Cost: 165 names are new public API, and unpublishing any of them later is a breaking change. The
  ones that are close to the line — `theme` (the singleton), the `config.ts` path helpers, the
  compaction internals — are candidates for removal by adding a missing paired re-export, not by
  reintroducing a list.
- Cost: 38 names removed here are breaking for anyone who imported them from the root; all of them
  were either unreachable from their source or wire-format details.
- `core/messages/codec.ts`'s `MessageCodecRenderOptions` is structurally identical to
  `MessageRunRenderOptions`. They stay separate names because the first is the codec table's and the
  second is what a module registers; unifying them is a follow-up that touches the codec table.

Related: PR #508 (`core/compaction/index.ts`) is the internal-barrel case where a pure `export *` is
correct, because nothing it exposes crosses a package boundary. PR #509 (`@nanopi/pi-tui` root
barrel) reached the opposite conclusion for a public root — keep the whitelist, add the missing
names, reject a whole-package `export *`. The difference is that `pi-tui`'s root is a rendering
surface with a deliberately small contract, while this one already hands out a whole agent;
`packages/tui`'s conclusion stands until its own issue says otherwise.
