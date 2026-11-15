# Agent Note: The entry-graph budgets count sources, not generated model catalogs

Status: implemented

## Problem

`pnpm run check` failed on `main` with

```
packages/coding-agent "." reaches 801 files, budget 780
```

while the tree was fine (#761). The 801 was a count of files reached by
`packages/coding-agent/src/index.ts`, and 303 of them are not in the repository: `models.generated.ts`
plus one `<provider>.models.ts` shard per provider, both gitignored products of
`pnpm run generate-models`.

Their number moves on its own. The generator writes one shard per provider models.dev lists, narrowed
by the build flavor that ran last, so the same commit measures differently depending on what happened
before the check:

| last generation | shards | `"."` reaches |
| --- | --- | --- |
| `full` | 302 | 801 (failed) |
| `base` | 16 | 515 (passed) |

Both runs were measured on this tree (`node scripts/check-entry-graphs.mjs` after each, and a
temporary `maxFiles: 1` budget to make the checker print the count). Neither number came from an
edit.

A budget whose input is a build product answers "which flavor did you build last", not "did this
change hang a new subsystem off the package root". The second question is what the budget exists for,
so the counting rule was wrong, not the number.

## Decision

`scripts/check-entry-graphs.mjs` keeps walking the catalogs but stops counting them.
`GENERATED_MODEL_CATALOG` matches `packages/ai/src/models.generated.ts` and
`packages/ai/src/providers/<provider>.models.ts`; `checkGraph` reports
`counted.length` against `maxFiles` and still runs `forbid` over the full graph, because a forbidden
path is a forbidden path whether or not it is generated.

The root budget becomes `maxFiles: 550` against 498 counted files (323 `coding-agent`, 122 `pi-ai`,
46 `pi-tui`, 7 `agent`). The headroom is the one the old 780 carried over 707, about 10%: it absorbs
a subsystem that lands with its own imports and does not absorb a barrel that starts re-exporting the
world.

`packages/coding-agent/test/root-barrel-exports.test.ts` pins both halves: the budget, and a
deliberately tiny budget (`maxFiles: 1`) whose violation listing must contain no generated catalog.
The second assertion is what fails if the exclusion is dropped again.

## Alternatives considered

**Raise the budget to 810.** It fixes today's number and nothing else. The next `models.dev` update
that adds a provider moves it again, on a commit that touched no file in this repository, and the
next person raises it again. The 780 was already a raise of this kind over an earlier measurement.

**Pin the shard set so the count is stable.** Point the generator at `buildconfig.json`'s provider
sets and never generate more. Rejected: `full` ships `presets` precisely so that a provider models.dev
adds is not silently dropped, and `validateFlavorProviders` fails the build when a catalog belongs to
no set. Making generation independent of the catalog would turn "a new provider exists" from a
decision into a number that does not move.

**Count the graph but normalize by shard count.** A ratio (`files / shards`) is stable and unreadable:
nobody can say what "40 sources per catalog" means, and the failure message would name a ratio
instead of the file that was added.

**Have the check generate the catalogs itself first.** The check would then take minutes and would
report on a tree it had just rewritten. `check:openai-client-size` already refused this argument for
`dist`
([note](../../implemented/bug-fix/2026-11-07-openai-size-check-reads-src-not-dist.md)): a check's
input must be the code it is checking.

**Leave the catalogs out of the walk entirely.** Cheaper, and it loses the one thing that made
counting them defensible: `forbid` patterns such as `packages/ai/src/index.ts` and
`core/session-manager.ts` still need to be evaluated against a graph that includes them, and a future
budget may legitimately need to say "the root must not reach the provider catalogs at all".

## Consequences

- `pnpm run check` no longer depends on which flavor generated the catalogs last. It still needs the
  catalogs to exist — a graph that cannot resolve `models.generated.ts` loses the one source
  (`model-catalog.ts`) only the shards reach — but that is a missing-file state
  `check-model-data-generated.mjs` already fails with the command that fixes it, not a count that
  drifts.
- The failure message is now a source count, so a new import is visible as a number that moved by
  one. The generated half of the graph is invisible to `maxFiles` and still visible to `forbid`.
- A real regression in the catalog layer is no longer caught here. It was not caught before either —
  the number moved by 286 between two unmodified builds, which is far more than any regression the
  budget could resolve.
- The 550 is a source count over four packages. `packages/ai`'s own share (122) is what the root
  reaches through `createAgentSession`; a new provider module is one file of it, and 302 of them were
  never in the number.

## Testing

`packages/coding-agent/test/root-barrel-exports.test.ts` asserts the budget passes and that a
`maxFiles: 1` violation listing excludes `models.generated.ts` and every `*.models.ts`.
`node scripts/check-entry-graphs.mjs` was run against the same tree after a `full` generation (302
shards, 801 files, 498 counted) and after a `base` generation (16 shards, 515 files, 498 counted):
both report "Entry point graphs are within budget".
