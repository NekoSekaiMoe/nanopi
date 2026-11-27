# Agent Note: sidecars are embedded again; the download channel is gone

Status: implemented

Ref: shinytale/nanopi#840

## Problem

`full` stopped embedding the TUI native prebuilds and photon wasm on 2026-11-07
([the embed note](../process/2026-11-06-sidecars-download-in-full.md)), moving
them to an on-demand download pinned by a manifest baked into the bundle. That
trade kept shrinking in the wrong direction: the download path dragged in a
release-only tarball, a second host (AtomGit), a four-second reachability probe
for `NANOPI_OFFLINE`, and a warning path that had already cost one bug (#586).
The user asked to delete the download entirely now that the sidecars are
embedded back into `nanopi.js`.

## Decision

`full` embeds both `sidecar/*` payloads again; all download machinery is deleted:

- `buildconfig.json` turns `sidecar/tui-native` and `sidecar/photon-wasm` on in
  `full` (the `"*": true` default) and the component descriptions no longer
  mention a fallback.
- `scripts/build-coding-agent-single-file.mjs` only builds the builtin
  gzip+base64 payload (`NANOPI_BUILTIN_SIDECARS`). The
  `NANOPI_SIDECARS` manifest, the GitHub/AtomGit URL builders, and the tarball
  emission are gone; `--sidecars-out` is removed from this script and from
  `scripts/build-single-file.mjs`.
- `packages/coding-agent/src/utils/sidecars.ts` shrinks to builtin install
  only: `installEmbeddedSidecars` replaces `ensureSidecars` /
  `ensurePhotonWasmSidecar`, and `photon.ts` no longer awaits a sidecar on first
  image read. `src/standalone/cli.ts` installs the embedded files at startup.
- Both release workflows drop every sidecar tarball step and asset:
  `.github/workflows/build-binaries.yml` and `.github/workflows/nightly.yml`
  no longer stage, check, or publish `nanopi-sidecars-<version>.tgz`.
  `scripts/publish-atomgit.mjs` publishes only the three bundles (plus a
  source archive for release tags).
- Tests that exercised the download path are removed from
  `packages/coding-agent/test/standalone.test.ts`,
  `scripts/publish-atomgit.test.mjs`, and
  `scripts/build-coding-agent-single-file.test.mjs` (the last file is deleted;
  its remaining cases only tested the removed nightly tarball step).

The builtin install path is unchanged: every embedded file carries a build-time
sha256, files for other platforms are skipped, and a corrupt or missing install
is repaired from the embedded copy. `base` and `minimal` never had these
components and are unaffected.

## Alternatives considered

- **Keep the download and embed together as fallback.** Rejected: the user
  asked to delete the download. Keeping it also keeps the manifest, URL hosts,
  offline probe, and tarball publishing that exist only for the fallback.
- **Embed only the current platform's prebuild.** Rejected again: the release
  builds one `nanopi.js` for every OS, so per-platform embedding forks the
  artifact per runner. All four prebuilds stay embedded; each machine installs
  only its own.
- **Drop photon entirely and resize images in pure JS.** Rejected: it changes
  behavior (slower codec, no WebP) rather than removing a delivery channel.
- **Keep a tarball as a release asset for manual recovery.** Rejected: nothing
  reads it once the download is gone, so it would be an unverifiable artifact.

## Consequences

- Cost: the `full` bundle grows by the packed sidecar payload (~0.9 MiB at the
  time of the earlier measurement; photon's larger wasm compresses poorly).
  Published releases no longer carry the sidecar tarball; anyone upgrading an
  old install keeps whatever was downloaded into `.nanopi/agent/bin`, now
  overwritten by the embedded copy at startup.
- Benefit: first image read and first clipboard use need no network;
  `NANOPI_OFFLINE` no longer changes sidecar availability; the offline probe,
  mirror URLs, release tarball, and their failure modes all disappear.
- The old sidecar decision notes are superseded:
  [buildconfig-gated builtins](../process/2026-10-11-sidecar-builtins.md),
  [`full` stops embedding](../process/2026-11-06-sidecars-download-in-full.md),
  [offline host probe](../process/2026-11-08-offline-sidecars-probe-hosts.md),
  [tarball path and mirror](../bug-fix/2026-11-10-sidecar-tarball-path-and-mirror-contract.md),
  [TUI sidecar mirror](../process/2026-11-06-tui-sidecar-mirror-and-prebuilds.md).
  They document why each step was taken; this note is the current state.
- The AtomGit assets repository keeps publishing the three bundles only;
  outdated README/tarball entries on already-published tags are not rewritten.
