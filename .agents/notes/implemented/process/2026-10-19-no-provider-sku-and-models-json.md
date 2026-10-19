# Agent Note: the no-provider SKU (minimal) and models.json

Status: implemented

## Problem

Issue #47 asked for a `minimal` SKU that is "the bash tool and nothing else".
The provider-set change shipped it with `providerSets.presets`: the binary
carried 51 provider catalogs, `/login` offered every vendor, and nothing said
where a model was supposed to come from. The user's follow-up was the real
requirement: in a minimal build you fill in the endpoint URL and the key
yourself.

That is `models.json`, and it already works (`baseUrl` + `apiKey` + `models`,
see `docs/models.md`). What was missing was the build state that makes it the
only path: a build with zero built-in providers, and guidance that points at
the file instead of at `/login` instead of leaving the user with an empty
picker.

## Decision

**`providers: "none"` is a provider set like any other.** `providerSets.none`
lists the marker `__NONE__`, next to the existing `__ALL__`. A set is a list,
so "no provider" is a one-element list with a marker rather than a special
flavor key or an empty array (an empty array is what a truncation bug looks
like). `resolveBuiltinProviderIds` turns the marker into `[]`; every other set
keeps its ids and `__ALL__` stays `undefined`, meaning "no runtime filter".

**The generator writes an empty catalog.** A run whose provider selection is
empty returns before touching the network and writes an empty
`src/models.generated.ts` (carrying `EMPTY_CATALOG_MARKER`), deletes every
shard, and leaves only the data manifest. Doing this before the fetches means a
no-provider build does not depend on models.dev, OpenRouter, or Vercel being
reachable.

**The generated state owns the "empty" case.** `readModelDataProviderIds`
returns `[]` when the aggregator carries the marker, so the shard check,
`check:model-data`, the hydration step and `tsc -p tsconfig.build.json` all run
unchanged. `readProviderStructure` treats an object with no API group as the
invalid file it is, instead of insisting a provider always has at least one
model.

**The runtime skips `/login` guidance.** `isNoBuiltinProviderBuild()` (empty
injected list) makes `auth-guidance.ts` print a `models.json` snippet with
`baseUrl`, `api`, `apiKey` and `models` instead of "Use /login to log into a
provider". The `baseUrl` and the key are exactly the two things the SKU asks
the user to supply.

## Alternatives considered

- **`providers: false` (a plain component switch).** The `providers` component
  exists to name a set, and `loadBuildConfig` rejects a non-string value there.
  Allowing a boolean would give the component two shapes, and the bundle script
  would then need to tell "switch off" from "set resolves to nothing".
- **An empty `providers: []` in `providerSets`.** Shortest config, but an empty
  array is indistinguishable from a generation bug that truncated the list.
  `__NONE__` is as explicit as `__ALL__` and validates the same way.
- **Keep `presets` and document `models.json` only.** That is the state the
  issue was opened against: the small SKU still ships 51 catalogs and every
  `/login` entry for a CLI that is meant to run one endpoint.
- **Teach `models.json` a "provider-less" mode** (top-level `baseUrl`/`apiKey`
  without a provider id). A real feature, but it invents a second config shape
  for a case the existing one already covers; the gap was guidance, not config.
- **Type-level `BuiltinProvider = string` for the empty catalog.** Try it: the
  catalog key type collapses to `never`, and widening it only there leaks
  `never` into `KnownProvider` and every consumer that indexes it. The empty
  catalog is a build-time state, not a typing problem; the source checkout that
  built it regenerates before `tsc` is meaningful.

## Consequences

- `minimal` ships no shard, no provider JSON, and no provider registration. Its
  assistant has one endpoint until the user writes `models.json`.
- A checkout that built `minimal` has an empty catalog tree. `full` work needs
  `pnpm run generate-models` (which restores the shards and the recorded
  provider list) or `pnpm run hydrate:model-data`. This is the same rule the
  provider-set change introduced, now with a state that has no shards at all.
- `tsc --noEmit` is not meaningful in that state: the 51 provider modules import
  their shards directly, so `check` and CI run against a generated full tree.
  `tsc -p packages/ai/tsconfig.build.json` is fine, because it only compiles
  `src` and the empty aggregator type-checks.
- The `base` flavor still ships `presets`: issue #47 only asked for `minimal` to
  be the bash tool alone plus a user-supplied endpoint.
- `docs/models.md` "Configure a compatible endpoint" is now the first step for
  the `minimal` SKU, not a fallback.
