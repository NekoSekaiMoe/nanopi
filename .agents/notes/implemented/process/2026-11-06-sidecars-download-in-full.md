# Agent Note: `full` stops embedding the native sidecars

Status: implemented

## Problem

`nanopi.js` (flavor `full`) was 11.0 MiB. The largest single contributor
after the model catalogs and the AWS SDK was a payload nobody measured when
it was added: the builtin sidecar block, 0.9 MiB packed, of which the photon
wasm alone is 4.19 MiB raw gzipped to its worst ratio in the whole artifact.

[bundled builtin sidecars](./2026-10-11-sidecar-builtins.md) embedded them on
purpose, to stop a release that had not uploaded its sidecar tarball from
printing `Failed to install @nanopi/pi-tui sidecars: … HTTP 404` at every
startup. That goal was met, but the same rule fires for every platform: one
artifact carries all four TUI prebuilds and the wasm, and each machine
installs one `.node` file while the other three ride along forever.

## Decision

`full` sets `sidecar/tui-native: false` and `sidecar/photon-wasm: false`. The
components keep their meaning and `minimal` never enabled them; only the
published artifact changes shape. `src/utils/sidecars.ts` already resolves
the download manifest (`NANOPI_SIDECARS`) when the builtin payload is empty
or absent, so the artifact falls back to the path it shipped with before the
builtin components existed: on-demand download pinned by per-file sha256, a
single stderr warning on failure, and degradation to raw images / no native
clipboard.

Measured on the same sources (`scripts/build-coding-agent-single-file.mjs`,
flavor `full`): 11,517,558 → 10,213,090 bytes, −1.24 MiB. `base` and
`minimal` are unchanged (6.7 MiB / 2.7 MiB) — they never embedded.

The release workflow still emits `nanopi-sidecars-<version>.tgz` and still
asserts it exists, because the download path now carries every platform.

## Alternatives considered

- Keep the embed and accept 11.0 MiB: rejected — the payload buys nothing
  for a machine that only needs its own `.node`, and `full` is the artifact
  people download over a network anyway.
- Embed only the current platform's prebuild at build time: rejected again
  for the same reason as in the original note — the release builds one
  artifact for all OSes, so this forks the artifact per runner.
- Drop the photon wasm stage entirely and reduce images in pure JS:
  rejected — the fallback is upstream's supported path and already
  implemented; removing the acceleration would be a behavior change, not a
  size change.
- Prune the highlight.js grammar set instead (0.2–0.9 MiB): not done here.
  It needs a new `grammars` component and per-flavor sets, so it is a
  separate change with its own tests.

## Consequences

- Cost: first image touch / first clipboard use on a fresh machine goes to
  the network. Offline mode keeps the old warning and degrades as before.
- Benefit: −1.24 MiB, and the four-platform embed no longer scales with every
  platform the TUI gains a prebuild for.
- The `full` flavor description and both component descriptions now say the
  sidecars are off in `full`, so the next reader does not re-add the
  `"*": true` assumption.
