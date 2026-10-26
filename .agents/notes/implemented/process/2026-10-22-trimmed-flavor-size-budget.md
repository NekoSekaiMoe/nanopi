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

`base` gains `export-html` (308 KiB of templates) in exchange: `--export`,
`/export` and `/share` all read those templates, and the component is a
template reader plus a renderer, not a subsystem. `base` does not gain `docs`;
that stays the `full` difference. It also does not gain `webui`: the browser UI
is a deployment shape (a Next 16 static export, Chrome 111+ / Safari 16.4+, a
`/chat` SSE bridge and provider-account CRUD on top of `@nanopi/pi-extra`), and
`base` is the terminal-first SKU. `nanopi webui` in `base` reports the
component as not included — the same clean "not in this build" path any other
dropped component takes — so the SKU carries no Next pipeline and no
half-working server.

Keeping `export-html` without `webui` also uncovered a bug the two components
had been hiding for each other: `--export` builds its CSS variables from
`getResolvedThemeColors()`, and the theme is installed by `initTheme()`, which
only ran later in `main()` on the way into a session mode. So `nanopi --export`
died with "Theme not initialized" in *every* flavor; `--export-html` had never
worked from the CLI. `main()` now initializes the theme before the export
branch.

**Grammars.** All 191 grammars load on demand: the size argument was settled
first (a 128-grammar eager table), then the heap it registered at startup was
rejected and the table became a name list, see
[grammars load on demand](../simplification/2026-10-26-grammars-load-on-demand.md). The size
budget this section fixed is unchanged: none of the grammars is in the entry
graph any more, and each one is its own 4 KiB chunk.

## Alternatives considered

- **Keep the whole 1.3 MiB grammar set eager.** Simplest, and `full` becomes
  11.3 MiB — outside the requested 10-10.5 MiB. The four largest grammars are
  also 370 KiB for languages no session writes. Deferring all of them instead
  of 128 costs nothing in size: no grammar is in the entry graph either way.
- **Trim `docs` from `full` (3.3 MiB packed).** It is the only asset component
  the system prompt points the model at (`docs/index.md`, `examples/`), so
  removing it changes behavior, not size. Not a size lever.
- **Re-encode every doc screenshot, keep them in `docs`.** Only one of the four
  is referenced; re-encoding all of them still costs 150 KiB for three files
  nothing links to.
- **Give `base` the 46 catalogs and let `models.json` handle the rest.** That
  is what `presets` did, and it is exactly the 1.5 MiB the issue asked about.
- **Ship `webui` in `base`.** It was the other half of the "don't ship dead
  commands" argument, and `base` loses it on purpose: the browser UI is a
  deployment shape, not a core capability, and it drags a Next build into a
  flavor meant for terminals. `nanopi webui` fails with "not included in this
  build", which is a legible absence rather than a broken command — the same
  trade `full` makes for nothing and `minimal` makes for both components.
- **Ship `export-html` in `base`.** Kept, for the opposite reason: the export
  path is 388 KiB of templates read by a single CLI command, and without it
  three separate entry points (`--export`, `/export`, `/share`) break at once.
- **A `providerSets.core` that also included every token-plan variant of every
  vendor.** 46 ids by another name; the data is the cost, not the list.

## Consequences

Measured with `NANOPI_BUILD_FLAVOR=<flavor> node
scripts/build-coding-agent-single-file.mjs`, esbuild metafile attribution:

```
full      12.6 MiB -> 9.3 MiB   assets 3.9 -> 1.4, JS 8.0 -> 7.0
base        6.0 MiB (new)       assets 0.1, catalogs 0.9 -> 0.2 (36 stubbed)
minimal     2.7 MiB -> 2.4 MiB  assets 0.3 -> 0, JS unchanged
```

`base` without `webui` is 6.0 MiB rather than the 6.7 MiB measured with it:
`nanopi webui` in `base` prints "the webui is not included in this build",
`--export` writes a working HTML file, and `--list-models` names only the
curated vendors.

- `full` lands under the 10 MiB target, with ~0.45 MiB of grammar headroom for
  the languages someone asks for next. Budgets below are as measured here; the
  catalog numbers moved again when `full` stopped shipping every catalog
  (206 -> 30 ids, 12.1 -> 9.4 MiB, 3.33 MiB of model data -> 0.30 MiB), see
  [curated provider catalog](2026-10-26-curated-provider-catalog.md).
- `base` reports its providers through `--list-models` and answers `/login`
  with only the six curated vendors. Any other vendor is a `models.json` entry.
- A `minimal` artifact no longer creates `~/.cache/nanopi/standalone/<version>`
  and no longer reads `package.json` for its version; both are asserted in the
  build output (`embedded assets: none`) and by `--version`.
- `docs/images/` now holds one file. Adding a screenshot back means adding a
  page that links it, not a file.
- `BUNDLED_LANGUAGES` is the place to add a language; a missing grammar
  degrades to plain rendering, never to an error.
