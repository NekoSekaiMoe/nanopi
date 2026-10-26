# Agent Note: Record the generated catalog set in buildconfig.json after the marker is gone

Status: implemented

## Problem

`pnpm run build` failed on a checkout whose `packages/ai` catalog was correct:

```
Error: No provider set lists: 302ai, abacus, abliteration-ai, ...
    at validateFlavorProviders (scripts/buildconfig.mjs:627:9)
    at scripts/build-coding-agent-bundle.mjs:61:1
```

`validateFlavorProviders` fails when a generated catalog shard belongs to no
provider set, because no flavor could ever select it. The 157 ids it named were
real shards: commit `6adcad26b` added a generic models.dev pass that writes a
catalog for every `@ai-sdk/openai-compatible` provider, but
`providerSets.all` still listed the 48 curated vendors it had before.

The set did not update itself because of how `recordFullProviderSet` found the
set to write:

```js
const full = Object.entries(config.providerSets).find(([, set]) => set.providers.includes(ALL_PROVIDERS));
if (!full) return;
```

That is a marker lookup. `6adcad26b` regenerated the catalog and the recording
step replaced `["__ALL__"]` in `all` with the concrete ids it wrote, which is
what the design intends ([provider sets](../process/2026-10-19-provider-set-build-component.md)).
From the next run on, no set carried `__ALL__`, so the lookup returned nothing
and the generator silently stopped writing `buildconfig.json` — while it kept
writing shards. Every provider models.dev added after that point landed on disk
unlisted, and the next build failed at `validateFlavorProviders`.

## Decision

A run that writes every catalog records the set the default flavor ships, not
the set that happens to hold `__ALL__`. The marker is still preferred when a set
carries one; otherwise the resolution goes through
`config.flavors[defaultFlavor].components.providers`.

A trimmed run still records nothing. `flavorProviderSelection` returns a
selection only for such a run, so `recordFullProviderSet` reads the same fact
the selection did (`generatorOptions.providers !== undefined`) instead of
re-deriving it, and a `--providers` / flavored run leaves the config alone.

`providerSets.all` is regenerated here with the 157 missing catalogs, plus
`morph` (which models.dev added while the fix was being verified) and its shard,
so the checkout matches what the generator writes.

## Alternatives considered

- **Keep the generator out of it and list the new providers by hand.** It fixes
  this checkout and breaks again on the next models.dev addition: the failure
  mode is a scheduled regression, not a one-off.
- **Write the concrete list into every set that ships "everything".** `presets`
  holds the same 48 vendors today, so it drifts the same way. Rejected as a
  second write target: no flavor ships `presets` (`full` ships `all`, `base`
  ships `core`, `minimal` ships `none`), the build only requires each catalog to
  be reachable from *some* set, and keeping two lists in sync reintroduces the
  duplication the bug came from. A set that wants the full catalog can name
  `__ALL__` and never drift at all.
- **Make `validateFlavorProviders` accept unreachable catalogs.** It exists to
  catch exactly this; widening it trades a build failure for a binary whose
  model list disagrees with `buildconfig.json`.
- **Have the generator fail when the config is stale instead of writing it.**
  Correct but hostile: `pnpm run build` would require a second command to get
  past a check the generator can satisfy itself.

## Consequences

- `buildconfig.json` stays a generated record for the full catalog, which is
  what the provider-set note already claimed; the recording is no longer a
  one-shot that quietly stopped after its first run.
- The default flavor is now load-bearing for the recording: a config where
  `defaultFlavor`'s provider component is not a string set name records
  nothing, and the drift comes back. That is the same assumption
  `flavorProviderSelection` makes.
- `presets` was a dormant 48-vendor list at the time of this fix. It is no
  longer dormant: `full` ships it, and it carries the same curated 30 ids as
  `all` ([curated provider catalog](../process/2026-10-26-curated-provider-catalog.md)).
  The two are kept equal on purpose, so the "second write target" argument above
  no longer applies — the generator writes `all`, and `presets` is edited
  alongside it.
- The build's cross-check is unchanged: unreachable catalog still fails, unknown
  provider in a set still fails.

## Testing

`packages/ai/test/generate-models-record-provider-set.test.ts` drives the real
generator in a repo-shaped fixture whose `all` set holds concrete ids and
serves a models.dev payload with one new provider. It asserts the new id lands
in `all`, and that a `--providers` run leaves the file byte-identical. It fails
on the pre-fix generator.
