# Agent Note: provider sets as a build component (the minimal and base SKUs)

Status: implemented

## Problem

`buildconfig.json` could drop modules, assets and OAuth flows, but never a
provider. Every flavor registered all 51 built-in providers and shipped all
their catalogs: a `minimal` build still answered `--list-models` with every
vendor in packages/ai, and issue #47 asked for the opposite — `minimal` should
be the bash tool plus nothing else, `base` the four built-in tools plus the
preset providers, `full` unchanged.

Two facts made "the build only offers these providers" impossible before:

- Provider registration is package-level: `ModelRuntime.create` registers
  whatever `builtinProviders()` returns, and that list is hardcoded in
  `packages/ai/src/providers/all.ts`.
- The model generator writes one catalog shard per provider and always wrote
  every shard, so there was no state in which only some providers existed.
  Dropping a provider at runtime alone would leave its data (and its code) in
  the artifact.

## Decision

**`providers` is a build component with values.** It sits next to `toolset`:
the flavor names one entry from the top-level `providerSets` map
(`all`, `presets`), the same way `toolset` names one of `toolsetComponents`.
`resolveFlavorProviders` returns the provider ids, and a flavor that names no
set ships every provider.

**The generator is what narrows the build.** `pnpm run build` exports
`NANOPI_BUILD_FLAVOR`; `scripts/generate-models.ts` reads the flavor through
`scripts/buildconfig.mjs` and writes only the shards of that flavor's set. The
aggregator (`src/models.generated.ts`), the per-provider shard files and
`src/providers/data/<provider>.json` all agree on that set, so
`readModelDataProviderIds` and the hydration step stay consistent without new
plumbing.

**The provider lists are recorded, not guessed.** The `all` set holds the marker
`__ALL__`; a generator run that writes more than a curated subset replaces the
marker with the concrete ids it wrote. That is what keeps `base`/`minimal`
(which only regenerate their own shards) from naming a provider whose catalog
no longer exists, and it is why hydrating or regenerating a checkout restores
the `full` package's catalog set without a separate step.

**The runtime filters its registration.** `isProviderIncluded` (in
`packages/coding-agent/src/build-components.ts`, defined through
`NANOPI_BUILD_PROVIDERS`) filters `builtinProviders()` in
`ModelRuntime.create`. Hand-written `models.json` providers are unaffected.

**Builds validate the two sides.** `validateFlavorProviders` runs in both the
bundle and the single-file script: every provider a set names must have a
catalog shard, and every flavor must ship every shard its build has. A missing
entry fails the build instead of producing a binary whose model list disagrees
with `buildconfig.json`.

## Alternatives considered

- **Runtime filter only** (register everything, then filter in
  `ModelRuntime`). Smallest change, and it is all `isProviderIncluded` would
  need, but the catalogs and their JSON data stay in the artifact — 51 provider
  modules for a build that offers one. The `minimal` SKU exists to be small.
- **Filter at `all.ts` with esbuild aliases, the way modules are stubbed.** The
  module stub plugin works because each module is a separate import the barrel
  names. Providers all come through one package entry and one generated
  aggregator, so an alias would have to rewrite the aggregator's exports. The
  generator route removes the data instead of shadowing it, and keeps the
  generated file honest for type checking.
- **A hand-written `minimal` provider list** (openai + anthropic + ...). Rejected
  as a second catalog to maintain: it drifts from the real provider ids, and
  the drift only shows up as a runtime "no such provider" error.
- **Making every provider its own `module/*` component.** 51 components, 51
  entries per flavor, and the module component machinery (stubs, barrel parsing)
  does not fit a provider that is a factory in a shared entry.
- **Widening `BuiltinProvider` to `string` unconditionally.** It would keep a
  trimmed build type-checking, but it also throws away the "is this a real
  provider id" check for every catalog consumer, `full` included.

## Consequences

- `minimal` is now the bash tool alone: `module/extra` (run modes, permission
  prompts, webui bridge) is dropped too, because the issue asked for no modes
  beyond the tool itself. Its assistant behaves like a shell-only agent: no
  approval prompts, no undo of a command.
- `base` and `minimal` ship `providerSets.presets`. The `presets` list equals the
  full catalog today; it exists so the next stand-in or gateway-only provider
  can stay out of the small SKUs by adding it to `all` alone.
- `full` regenerates all shards, so `src/models.generated.ts` and the shard set
  stay as they were; only the small flavors produce a different tree, and a
  checkout that built one needs `pnpm run generate:models` before working on
  `full` again.
- The preset catalogs still contain the model data of every provider in the set;
  the savings are the dropped providers' shards and JSON, not a per-model trim.
- `BuiltinProvider` becomes `string` in a trimmed build only (the type detects
  the missing provider keys), which keeps `Model` values with a `provider` field
  type-checking without weakening `full`.
- Adding a provider now touches three places: its shard, a provider set in
  `buildconfig.json`, and (for a preset) the first-party list. The bundle script
  fails when they disagree.
