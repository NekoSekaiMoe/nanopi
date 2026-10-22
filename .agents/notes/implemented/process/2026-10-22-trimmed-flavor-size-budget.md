# Agent Note: the trimmed flavor size budget (assets, catalogs, grammars)

Status: implemented

## Problem

Issue #149 measured the three single-file flavors and found a 12.6 MiB `full`
against a 2.7 MiB `minimal`. The gap came from three separate places, and only
one of them was the API implementations `buildconfig.json` could already trim:

- 3.9 MiB of embedded assets, of which three doc screenshots (~2.4 MiB) had no
  reference anywhere, one screenshot was a 519 KiB flat PNG of a 64-color
  screen, and `README.md` + `CHANGELOG.md` alone accounted for 376 KiB packed.
  `minimal` still embedded 0.3 MiB (330 KiB of it the changelog) although it
  carries no docs, webui or export templates: the payload was a lone
  `package.json`.
- `packages/ai` shipped 46 provider catalogs (1639 KiB of shards) in every
  flavor. An esbuild probe showed the API sets are worth ~49 KiB; the model
  data is the real cost. So `base` had nothing to save by trimming APIs.
- 22 highlight.js grammars, 149 KiB raw. An agent session reads HTML, CSS,
  YAML, SQL, Dockerfiles, PowerShell and diff output far more often than it
  reads Perl or Scala, and the rest of the 1.3 MiB grammar set was locked out
  by the "eager fifteen then load the rest lazily" split.

## Decision

`full` targets 10-10.5 MiB, `base` is the curated SKU, `minimal` keeps no
assets at all.

**Assets.** Three screenshots are deleted (`exy.png`, `tree-view.png`,
`doom-extension.png`: zero references in the repo). `interactive-mode.png` is
re-encoded PNG8 with a 64-color adaptive palette (519 KiB → 48 KiB, visually
identical for a terminal screenshot) because two docs pages reference it.
`README.md` and `CHANGELOG.md` are no longer embedded by any flavor: the
standalone artifact documents itself through the embedded `docs/` tree, and no
runtime path opens either file. The npm package still ships both.

**No assets means no payload.** A flavor with no `docs`/`examples`/`webui`/
`export-html` component (`minimal`) embeds nothing, not even `package.json`:
pointing `NANOPI_PACKAGE_DIR` at a cache tree holding one file is worse than
leaving it unset. `config.ts` reads that path at module init to get `VERSION`,
`APP_NAME` and `CONFIG_DIR_NAME`, so the build injects
`NANOPI_SINGLE_FILE_VERSION_FALLBACK` for the version and keeps the defaults
for the other two.

**Provider catalogs.** `providerSets.core` lists the six vendors a trimmed CLI
keeps (openai, google, anthropic, glm/z.ai, kimi, qwen — 12 catalog ids,
because each vendor has several token-plan entries). `base` ships `core`,
`full` ships `all`. `validateFlavorProviders` no longer requires the flavor
being built to ship every catalog, which was the rule that made a middle tier
impossible; it requires every catalog to be in *some* set, so no shard is
unreachable, and every set to name existing catalogs.

`base` gains `webui` and `export-html` (1.2 MiB of assets, 388 KiB of export
templates) in exchange: without them `webui`'s browser UI and `export-html`'s
CLI command were dead features in a 6.7 MiB binary that is otherwise a
complete CLI. `base` does not gain `docs`; that stays the `full` difference.

**Grammars.** `EAGER_LANGUAGES` grows from 22 to 128 named imports: the
languages an agent actually reads (markup, config, query languages, the
mainstream set, and the diff/patch shells), minus the four grammars that cost
most (mathematica 135 KB, isbl 108 KB, 1c 64 KB, gml 60 KB) and the ones with
no plausible code-block tag. `loadAllHighlightLanguages()` still defers the
remaining 63 grammars through `highlight.js/lib/index.js`.

## Alternatives considered

- **Keep the whole 1.3 MiB grammar set eager.** Simplest, and `full` becomes
  11.3 MiB — outside the requested 10-10.5 MiB. The four largest grammars are
  also 370 KiB for languages no session writes.
- **Trim `docs` from `full` (3.3 MiB packed).** It is the only asset component
  the system prompt points the model at (`docs/index.md`, `examples/`), so
  removing it changes behavior, not size. Not a size lever.
- **Re-encode every doc screenshot, keep them in `docs`.** Only one of the four
  is referenced; re-encoding all of them still costs 150 KiB for three files
  nothing links to.
- **Give `base` the 46 catalogs and let `models.json` handle the rest.** That
  is what `presets` did, and it is exactly the 1.5 MiB the issue asked about.
- **Drop `webui`/`export-html` from `base` and call it leaner.** A CLI that
  ships `nanopi webui` and `--export-html` as broken commands is not a smaller
  SKU, it is a broken one.
- **A `providerSets.core` that also included every token-plan variant of every
  vendor.** 46 ids by another name; the data is the cost, not the list.

## Consequences

Measured with `NANOPI_BUILD_FLAVOR=<flavor> node
scripts/build-coding-agent-single-file.mjs`, esbuild metafile attribution:

```
full      12.6 MiB -> 9.3 MiB   assets 3.9 -> 1.4, JS 8.0 -> 7.0
base        6.7 MiB (new)       assets 1.2, catalogs 0.9 -> 0.2
minimal     2.7 MiB -> 2.4 MiB  assets 0.3 -> 0, JS unchanged
```

- `full` lands under the 10 MiB target, with ~0.45 MiB of grammar headroom for
  the languages someone asks for next.
- `base` reports its providers through `--list-models` and answers `/login`
  with only the six curated vendors. Any other vendor is a `models.json` entry.
- A `minimal` artifact no longer creates `~/.cache/nanopi/standalone/<version>`
  and no longer reads `package.json` for its version; both are asserted in the
  build output (`embedded assets: none`) and by `--version`.
- `docs/images/` now holds one file. Adding a screenshot back means adding a
  page that links it, not a file.
- The eager grammar table is the place to add a language; a missing grammar
  degrades to plain rendering, never to an error.
