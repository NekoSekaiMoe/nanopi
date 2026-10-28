# Agent Note: Bundled extras as flavor-controlled default packages

Status: implemented

## Problem

Eleven extension packages the user runs from `~/.pi/agent/settings.json`
(nine local checkouts plus `npm:pi-rewind` and `npm:pi-simplify`) lived
outside the nanopi repo: every distribution had to be configured by hand,
and nothing about them was build-controllable. The goal (user decisions):
vendor all eleven into the repo, make each one an optional build component,
register them automatically at runtime, and land extracted copies in
`~/.nanopi/packages` — deliberately not under `~/.nanopi/agent`.

## Decision

Extras are vendored under `packages/coding-agent/extras/<name>/` (upstream
snapshots; `devDependencies`/`scripts`/`tsconfig.json`/`*.bak` stripped
because the repo never builds them and the upstream tsconfig `extends` paths
do not exist here). One `extra/<name>` component per package in
`buildconfig.json`; `scripts/extras.mjs` cross-validates directories against
components (both directions fail the build on drift) and copy-assets plus
the single-file build copy enabled extras into `dist/extras/<name>`.

Registration reuses the user-package machinery instead of inlining code:
`PackageManager.resolve()` appends `getBundledExtraPackageSources(...)` after
project and global settings, so user configuration wins collisions by
package identity (path) and by npm name (an extra the user already takes as
`npm:<name>` is skipped entirely). Which directory each extra resolves from
depends on the distribution:

- npm installs and source checkouts register `dist/extras/<name>` in place;
- single-file runs copy each extra from the extracted payload cache to
  `~/.nanopi/packages/<name>`. The copy is marked by a
  `.nanopi-extra-version` marker (version + content hash) and replaced
  atomically when either changes — see
  [content-hash refresh](../bug-fix/2026-10-11-content-hash-refresh-single-file-caches.md);
  a directory there without the marker is user-owned and never touched.

`NANOPI_BUNDLED_EXTRAS=0` disables registration globally (vitest runs with
it; users can use it too). Vendored extras' own tests are excluded from
vitest discovery along with `dist/`.

Three compatibility gaps surfaced while loading the vendored sources, all
fixed rather than patching the packages:

- `readNanoPiManifest` only read `pkg.nanopi`; upstream packages declare the
  `"pi"` manifest field. It now falls back to `pkg.pi` (`nanopi` wins).
- The extension loader's alias map and the bundle's virtual modules did not
  know `@earendil-works/pi-*` (the fork's upstream name), unlike the already
  aliased `@mariozechner/pi-*`. Both maps (and the root tsconfig paths, for
  source-checkout runs) now mirror the mariozechner entries.
- `findPackageDirectories` walks `packages/` recursively and had no concept
  of vendored directories: the extras would have been discovered as public
  workspace packages and npm-packed at release. Any directory named
  `extras` is now skipped; ts-imports and biome allowlists already excluded
  them structurally.

## Alternatives considered

- **Static built-in extensions** (llama.cpp-style factories). Rejected: one
  factory shim per package, and flavor pruning would need lazy bundle
  entries for each. Registering as packages keeps upstream snapshots
  loadable and upgradeable by dropping in files.
- **pinned npm dependencies + build-time copy** for pi-rewind/pi-simplify.
  User chose vendoring the published sources into the repo instead.
- **`~/.nanopi/agent/packages`** (mirroring `~/.pi/agent/packages`). User
  decision: extracted extras go directly to `~/.nanopi/packages`, nothing
  nested under `~/.nanopi/agent`.
- **Runtime `components.json`-style manifest of bundled extras.** The
  `dist/extras` directory listing is already the flavor's ground truth
  (directories are simply absent when disabled); a second manifest would
  drift.

## Consequences

- full builds gain ~205 KiB gzipped extras (single-file 15.8 → 16.2 MiB,
  249 → 399 embedded files); minimal builds gain nothing.
- Verified end to end: `--mode rpc` on a real single-file build in an
  isolated HOME activates extras (rewind/todo/codex-hooks status widgets)
  from `~/.nanopi/packages`.
- Extras load with lowest precedence; `nanopi package list` does not show
  them (it lists configured settings packages) — flavor is the control
  surface, plus the env kill switch.
- Upstream sync is manual file replacement under `extras/`; the build fails
  if a new directory lacks a `buildconfig.json` component.
- Fact update 2026-10-11: pi-extra-cmd and pi-codex-compact were later
  promoted to built-in inline extensions and removed from the registry
  ([builtin commands and codex compaction](2026-10-11-builtin-commands-and-codex-compaction.md));
  the registry now carries nine extras.
- The `"pi"` manifest fallback also benefits user-installed pi-ecosystem
  packages, restoring behavior the rebrand dropped while the import aliases
  were kept.
- Fact update 2026-10-28: pi-rewind and pi-simplify were re-synced against
  upstream `HEAD`; the remaining deltas are the module-API renames plus
  upstream bug fixes, and pi-simplify now keeps its upstream test suite. See
  [vendored extra tests and HEAD sync](../process/2026-10-28-vendored-extra-tests-and-head-sync.md).

Related: [build flavors via buildconfig.json](../process/2026-10-11-build-flavors-buildconfig.md)
(the component system this builds on),
[single-file release artifact](../process/2026-10-11-single-file-release-artifact.md)
(the asset payload the extras ride on).
