# Agent Note: Build flavors via buildconfig.json

Status: implemented

## Problem

Every build shipped every peripheral component: the webui assets (~1.1 MiB),
export-html templates, docs (~2.8 MiB) and examples (~1.4 MiB) embedded in
single-file builds, all OAuth flows as lazy bundle entries, all copied into
`dist/` unconditionally. There was no way to produce a smaller distribution,
and the planned goal module needs an inclusion switch before it lands. The
requirement (user decision): one root config, multiple flavors, affecting the
multi-file bundle build, the single-file build, and asset copying — but npm
packages always publish `full`.

## Decision

The root `buildconfig.json` is a data-only registry: `components` (name +
description) and `flavors` (component maps with `*` fallback; unlisted
components default to enabled so a new component forgotten in a flavor stays
bundled). `scripts/buildconfig.mjs` loads, validates, and resolves it;
selection order is `--flavor <name>` CLI argument over the
`NANOPI_BUILD_FLAVOR` environment variable over `defaultFlavor`. The variable
only reaches the scripts that read it themselves (bundle, single-file); asset
copying takes it from `--flavor` alone.

Build wiring:

- `scripts/build-coding-agent-bundle.mjs` skips the lazy entry of every
  disabled `oauth/*` flow and injects the resolved map as esbuild defines.
- `scripts/build-coding-agent-single-file.mjs` drops disabled asset trees
  (webui, export-html, docs, examples) from the embedded payload and, when any
  OAuth flow is disabled, aliases `@nanopi/pi-ai/bundled-oauth` (via an
  esbuild onResolve plugin) to a generated shim that statically registers only
  the enabled flows.
- `copy-assets` became `packages/coding-agent/scripts/copy-assets.mjs`
  (previously a shx one-liner) so export-html and webui copies are conditional.
  It resolves its flavor from `--flavor` only: `pnpm run build` invokes it as a
  child process, and npm/pnpm put `NANOPI_BUILD_FLAVOR` back into that process,
  so an exported flavor would delete `dist/webui` and `dist/core/export-html`
  for every later build that expects them. The release workflow is unaffected —
  it builds `base`/`minimal` with the single-file script, which reads its own
  flavor and writes one file.

Runtime contract: builds inject `NANOPI_BUILD_COMPONENTS` (object literal) and
`NANOPI_BUILD_FLAVOR`. Guards follow the existing `NANOPI_SINGLE_FILE` pattern
(`declare const X | undefined` + `typeof X !== "undefined"`, see
`src/standalone/assets.ts`): `isBuildComponentEnabled` in
`packages/coding-agent/src/build-components.ts` (webui subcommand,
`generateHtml`) and `isOAuthFlowBundled` in `packages/ai/src/auth/oauth/load.ts`
(inside `importOAuthModule`, the single choke point for every flow). Disabled
components fail with "not included in this build" errors instead of
module-not-found crashes. Without the defines (source checkouts, npm installs,
the published `full` package) every component is enabled.

`scripts/oauth-flows.mjs` is the flow registry (module, loader key, export
name). `validateOAuthFlowRegistry` cross-checks it against the
`importOAuthModule("./<flow>.ts")` call sites in `load.ts` and against the
`oauth/*` entries in `buildconfig.json`, so a new flow that forgets either the
registry or the component fails the build instead of failing at runtime.

The `goal` component is registered but has no build wiring yet; its switch
lands together with the module.

## Alternatives considered

- **Runtime `components.json` manifest instead of defines.** A file emitted
  next to the bundle would be readable without esbuild support, but checks
  become filesystem reads (sync at command dispatch or async everywhere), the
  single-file build would have to embed it in the asset payload, and the repo
  already has a proven define pattern (`NANOPI_SINGLE_FILE`). Defines also
  make disabled branches dead code for the minifier.
- **Per-package buildconfig.json.** Flavors span three packages and the root
  scripts (asset copy in coding-agent, flows in ai, bundling at the root); a
  per-package split would need a merge layer with no consumer that wants only
  a slice. One root file is the single source of truth.
- **Flavor-filtered npm tarballs** (staging repack after `npm pack`, or
  mutating the `files` array during publish). User decision: npm packages
  always publish `full`; `scripts/publish.mjs`/`package-artifacts.mjs` stay
  flavor-free. Tarball surgery would also interact badly with npm provenance.
- **Excluding the webui-server/CLI code itself, not just its assets.** The
  assets dominate the size; code-level dead-code elimination (define-guarded
  mode registration) can come with the goal module if profiles need it.

## Consequences

- `minimal` single-file builds skip ~5 MiB of embedded assets and all OAuth
  flow code; `minimal` bundle builds skip the OAuth lazy entries.
- In a flavor without docs/examples, the system prompt and auth guidance still
  print their paths (they may not resolve). Accepted as cosmetic; consumers
  only format strings, never read the trees.
- Disabled OAuth flows surface as clean login errors ("OAuth flow \"xai\" is
  not included in this build") through `lazyOAuth`'s existing error paths.
- Adding an OAuth flow now requires three synchronized entries (load.ts,
  `scripts/oauth-flows.mjs`, `buildconfig.json`) — enforced mechanically by
  `validateOAuthFlowRegistry` at every flavored build.
- `pnpm run check` is flavor-independent (it validates source graphs), and the
  published npm layout is unchanged.

Related: [single-file release artifact](2026-10-11-single-file-release-artifact.md)
(embedded asset payload this note makes conditional),
[port-atomcode-webui](../architecture/2026-10-11-port-atomcode-webui.md)
(the webui component this note makes optional).
