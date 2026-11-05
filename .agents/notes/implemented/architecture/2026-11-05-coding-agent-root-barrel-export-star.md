# Agent Note: The coding-agent root barrel converts only the sources whose whole export set is already public

Status: implemented

## Problem

Issue #506 asked to make `packages/coding-agent/src/index.ts` use `export *`.
By the time this landed, PR #508 had already restored
`core/compaction/index.ts` to `export *` and pinned it with a regression test
(`test/compaction-barrel-exports.test.ts`): a hand-maintained whitelist there had
silently dropped `getSummarizationFailure` with no compiler or test failure, and
the graph cost that once justified the whitelist was independently cut to 19
files. The lesson — a wildcard follows its source files by construction — is
what motivated the #506 request.

`src/index.ts` is not an internal barrel like compaction's. It is the package's public entry
(`package.json` `exports["."]` -> `dist/index.js`), and its 573 lines are a
deliberate public API boundary: 45 source modules, 516 names, with many
internal symbols (`theme`, `getAuthPath`, `printHelp`, `createSessionManager`,
`getInContextCompactionOutcome`, ...) intentionally kept out. The whitelist
here does not compress the module graph (that is
`scripts/check-entry-graphs.mjs`'s job on `./modules` / `./ui` /
`core/compaction/index.ts`); it decides what SDK users may import.

## Decision

Convert the 9 sources whose complete export set is already in the whitelist
to `export *`, and leave the other 36 as named re-exports.

The 9 are `build-components.ts`, `core/bash-executor.ts`, `core/defaults.ts`,
`core/event-bus.ts`, `core/model-runtime.ts`, `core/resource-discovery.ts`,
`core/tool-patterns.ts`, `modules/index.ts`, `utils/frontmatter.ts`. For each,
`source full export set == whitelist block` (16/3/2/3/5/3/1/2/2 names,
`added=[]`, `removed=[]`), so the public surface is byte-for-byte unchanged
while these barrels now pick up future source exports without a manual edit.

Verification: `tsc --noEmit -p tsconfig.json` exits 0 with no output;
`pnpm run check` exits 0; a scripted diff of the whitelist set against each
source's full export set reports no added/removed names for all 9.

The other 36 stay named. For 27 of them, `export *` would push 1..29 internal
symbols per module onto `exports["."]` (267 distinct names total in the union)
— that is a product decision about the public API, not a mechanical rewrite.
The remaining collisions are listed below.

## Alternatives considered

**Convert all 45 sources to `export *`** (the literal request). Rejected with
compiler evidence, not taste. A probe rewriting all 45 blocks to `export *`
made `tsc --noEmit -p tsconfig.json` fail with two TS2308 ambiguity errors:

- `./core/messages/index.ts` and `./core/modules/index.ts` both export
  `MessageRunRenderOptions`;
- `./core/compaction/index.ts` and `./core/settings-manager.ts` both export
  `CompactionSettings`.

A static pass found 29 names exported by 2+ of the 45 sources (e.g.
`ModuleApi`, `ToolDefinition`, `createBashTool`, `BuildSystemPromptOptions`).
`export *` resolves such conflicts by dropping the ambiguous name, which is
exactly the "whitelist silently loses a name" failure #506 objects to, except
here it also breaks the typecheck. Fixing the two TS2308s with explicit
re-exports would still leak the 267 internal symbols, so this path changes the
public API contract in a way nobody asked for.

**Wrap every colliding name with an explicit re-export** (the TS2308
"Consider explicitly re-exporting" hint). Rejected for the same reason: it
suppresses the ambiguity errors but does not stop the 267 internal names from
becoming public. It also adds a second maintenance list on top of the
whitelist.

**Add a whitelist/source diff check** (the "源导出集合减去白名单的差集检查"
promised earlier in #506). Not done here: it would need a committed 267-name
"intentionally not public" baseline — another whitelist, working against the
"names flow automatically" goal — and it belongs to the barrel-layering work
rather than to this single file. Left as a follow-up, not silently forgotten.

## Consequences

- Gain: 9 barrels no longer need a manual whitelist edit when their source
  gains an export; the "source adds a name, barrel does not follow" failure
  mode is gone for those 9.
- Cost: 36 barrels still carry that failure mode. The public/private boundary
  stays explicit and reviewable in one file.
- This is deliberately partial. A full conversion needs a separate decision
  to either expose or deliberately hide those 267 names; the data above is the
  input to that decision. PR description carries the same numbers.

Related: PR #508 (`core/compaction/index.ts`) is the internal-barrel case where
a pure `export *` is correct, because nothing it exposes crosses a package
boundary. PR #509 (already merged, `@nanopi/pi-tui` root barrel) reached the
same conclusion as this note for a public root: keep the whitelist and add the
missing named exports, rejecting a whole-package `export *`. The public/private
distinction between those two barrels is why this file is only partly converted.
