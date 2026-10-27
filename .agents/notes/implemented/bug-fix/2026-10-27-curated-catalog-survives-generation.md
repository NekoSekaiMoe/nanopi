# Agent Note: A curated provider set survives a model generation run

Status: implemented

## Problem

Issue #329 asked why the `full` artifact grew from 12.1 to 13.0 MiB. The model
data was back: `full` ships `presets`, curated to 30 catalogs by
[curated provider catalog](../process/2026-10-26-curated-provider-catalog.md),
and the built artifact carried 208 catalog shards — 3.87 MiB of them, including
the five aggregators that note had explicitly left out.

`recordFullProviderSet` was the cause. It found the set to write by marker:

```js
const markerSet = Object.entries(config.providerSets).find(([, set]) => set.providers.includes(ALL_PROVIDERS));
const shipped = markerSet?.[0] ?? config.flavors[config.defaultFlavor]?.components[PROVIDERS_COMPONENT];
```

The fallback was added by
[provider set recording](../bug-fix/2026-10-26-provider-set-recording-survives-marker-replacement.md)
so a config whose marker had already been expanded kept recording new catalogs.
Curating the catalog removed the last marker: `all` became 30 concrete ids, and
`presets` was 30 concrete ids. From then on every `pnpm run generate:models`
took the fallback, resolved `defaultFlavor` (`full`) to `presets`, and wrote all
207 catalogs into it. One generation run restored the 3.5 MiB the curated note
had removed, and it did so silently — the build still passed, the flavor still
said `presets`.

## Decision

A generation run rewrites only a provider set carrying the `__ALL__` marker. A
config whose sets all list concrete ids is curated on purpose and is left
alone; the pure decision lives in `providerSetRecord()` in
`scripts/buildconfig.mjs`.

A catalog models.dev adds is not silently dropped either. It is in no set, so
`validateFlavorProviders` fails the build and names it, which is the check that
note had been leaning on: a vendor is added to a set by a person deciding it
belongs there, not by a generator widening a curated list.

The marker stays the write target because it is the set that means "these are
the catalogs that exist". A curated set next to it is a shipping decision — what
a flavor carries — and those are different questions.

## Alternatives considered

- **Keep the fallback and make `presets` carry the marker.** `full` would then
  ship every catalog, which is the 3.5 MiB the curated note removed. The marker
  also turns `resolveBuiltinProviderIds` into `undefined`, so no catalog would
  ever be stubbed, and the size lever would be gone from the whole build.
- **Keep the fallback and write into `all` instead of the default flavor's
  set.** Smaller change, but `all` exists as the record of what the generator
  wrote, and `presets` is the curated list `full` ships; writing 207 ids into
  `all` re-creates the drift the curated note was about (two lists that no
  longer agree), and it leaves `presets` as the only curated list with nothing
  checking that it is reachable.
- **Have the generator fail when a new catalog is in no set.** Correct, and the
  build already does this through `validateFlavorProviders`; a second failure in
  the generator would report the same fact twice, and generation is the step
  that is supposed to succeed so the build can run.
- **Re-derive the write target from the flavor that ships `__ALL__`.** No flavor
  does after curating, so the rule would have nothing to act on; the marker
  itself is the simpler statement of the same intent.

## Consequences

- `pnpm run generate:models` no longer rewrites `buildconfig.json` in this
  repository: every set lists concrete ids. A new models.dev provider now fails
  `validateFlavorProviders` until someone lists it in a set, which is the
  intended way for a curated catalog to grow.
- `full` is back to 30 catalogs: 177 shards are stubbed out of the build, and
  the single-file artifact measures 13.3 MiB → 10.7 MiB (`stubbed catalogs: 177`
  in the build output).
- A config that still carries `__ALL__` in one set keeps recording there, so a
  downstream flavor that wants the whole catalog needs no code change.
- The note this supersedes kept its alternatives for a config that had no marker
  at all; that case is now the normal one, which is why the decision moved. Its
  `## Decision` section still describes the 2026-10-26 state; this note is the
  authority on what the code does now.

## Testing

`providerSetRecord` is unit-tested in `scripts/buildconfig.test.mjs` (curated
config, marker config, already-matching marker set, curated set beside a
marker). `packages/ai/test/generate-models-record-provider-set.test.ts` drives
the real generator in a repo-shaped fixture: one case asserts a curated config
stays byte-identical while the new shard is still written, the other asserts the
marker set records the new catalog and the curated set beside it is untouched.
