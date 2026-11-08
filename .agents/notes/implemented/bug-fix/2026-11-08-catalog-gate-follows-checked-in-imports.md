# Agent Note: Decide a model catalog is missing by the checked-in imports, not by two files

Status: implemented

## Problem

Issue #603 reported a `pnpm run check` that failed with 16 `TS2307` errors, one
per provider, on a checkout where `check:model-data` had just printed
`Generated model data is valid.`:

```
src/providers/alibaba-token-plan.ts(4,43): error TS2307: Cannot find module './alibaba-token-plan.models.ts'
src/providers/baseten.ts(4,32): error TS2307: Cannot find module './baseten.models.ts'
... 14 more, plus one TS2322 on cloudflare-workers-ai.ts
```

The catalog was not absent. A `base`-flavor generator run had written it:
`providerSets.core` is 16 of the 32 providers. That catalog is *internally
consistent* — its aggregator names exactly those 16 shards, its `data/` matches
the aggregator, and `validateGeneratedModelData` passes on it. What it cannot
satisfy is the checked-in source: `src/providers/all.ts` imports every provider
module, and each of those imports its own shard.

`ensure-model-catalogs.ts` is the gate that is supposed to catch this, and it
was two `existsSync` calls:

```ts
const required = [
	join(packageRoot, "src", "models.generated.ts"),
	join(packageRoot, "src", "providers", "data", ".manifest.json"),
];
if (required.every((path) => existsSync(path))) process.exit(0);
```

Both files are present in the trimmed catalog, so it exited 0 and `tsc` reported
the 16 errors instead.

The tempting alternative — compare the aggregator against the shard directory —
cannot find this bug, because the aggregator *is* the record of the narrow run.
It agrees with the 16 shards by construction.

## Decision

`ensure-model-catalogs` treats the catalog as missing when a shard the
**checked-in source** imports is not on disk. `findReferencedShardNames` walks
`src/`, skips `data/` and `disabled/`, skips the generated
`src/models.generated.ts`, and collects every `from "….models.ts"` specifier.
The resulting set is the union of what `all.ts` and the provider modules need,
independent of which flavor wrote the catalog last.

`findMissingShardNames` is that set minus what is on disk, and it is exported so
the regression test asserts on the predicate rather than on spawn output.

The trigger is an import graph, not a flavor. A `base` run is legitimate — the
binary genuinely ships 16 providers — but it must not be *read* by a tree that
imports 32. The check is therefore about the checkout's ability to type check,
which is what `ensure-model-catalogs` exists for.

## Alternatives considered

- **Compare the aggregator with `src/providers/*.models.ts`.** This is what
  `readModelDataStructure` already does, and it passes on the broken state. It
  answers "is this catalog self-consistent", not "can this tree be compiled".
- **Make the generator refuse to leave a narrow catalog behind.** It cannot: a
  `base` build is supposed to ship a narrow catalog, and nothing stops a shell
  from exporting `NANOPI_BUILD_FLAVOR` before an unrelated `check`.
- **Have `check-model-data` fail on a narrow catalog.** Same wrong target: the
  narrow catalog is valid data. The consumer that breaks is `tsc`, through
  imports `check-model-data` never looks at.
- **Read `buildconfig.json`'s full provider set as the expectation.** That ties
  a type check to a build config a checkout can legitimately curate, and the
  config is generated too — see
  [provider set recording](2026-10-26-provider-set-recording-survives-marker-replacement.md).
  The checked-in imports have no such indirection.

## Consequences

- The gate now runs whenever any imported shard is absent, which on a `base`
  checkout is "always". That is the point: the first `pnpm run check` after a
  flavored run regenerates the full catalog instead of failing 16 times.
- A checkout that wants to stay narrow for type checking no longer can. Nothing
  in the repo relied on that; `build:offline` selects its shards inside the
  generator, after `ensure-model-catalogs` has run.
- `readModelDataStructure` keeps its `shardNames.length > 0` guard. An empty
  shard directory is a `--data-only` hydration, which writes data for a catalog
  whose shards it leaves alone; once *any* shard exists the set is checked in
  full. The old guard also let an aggregator naming 32 providers sit beside zero
  shards, which is a real mismatch — the strict-once-populated form rejects it.

## Testing

`packages/ai/test/model-data-validation.test.ts`, under "catalogs left by a
narrower build flavor", asserts: `findMissingShardNames` reports the shard a
trimmed catalog omits, reports nothing when the imports are satisfied, and does
not take the generated aggregator as the expected set. The last one is the
regression proper — with the aggregator as the expected set the omission looks
correct, which is why the pre-fix gate admitted it.

Verified end to end: after a `NANOPI_BUILD_FLAVOR=base corepack pnpm run
generate:models` left 16 shards, `pnpm run ensure:model-catalogs` regenerated all
211, a second run exited 0 silently, and `tsc --noEmit` went from 16 errors to
none.
