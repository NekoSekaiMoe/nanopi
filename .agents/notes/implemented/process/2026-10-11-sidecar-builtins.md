# Agent Note: buildconfig-gated builtin sidecars for single-file builds

Status: implemented

## Problem

The single-file `nanopi.js` downloaded its native sidecars (TUI `.node`
prebuilds, photon wasm) on every fresh machine, even though the files are
tiny (156K for all six platform prebuilds, 1.8MB wasm). On unreleased
versions the GitHub Release asset does not exist yet, so every startup
printed `Failed to install @nanopi/pi-tui sidecars: … HTTP 404` before
degrading gracefully — noise for a fallback path that should rarely run.

## Decision

Sidecars follow the same rule as every other buildconfig component: enabled
in the flavor means builtin. Two new components, `sidecar/tui-native` and
`sidecar/photon-wasm` (both on in `full` via `"*"`, off in `minimal`), control
`scripts/build-coding-agent-single-file.mjs`: enabled contents are packed as
gzip+base64 (`NANOPI_BUILTIN_SIDECARS`) and installed by
`src/utils/sidecars.ts` into the agent bin directory with the same sha256
verification as downloads — no network, no warning. The download manifest is
kept untouched as fallback (corrupt embed, disabled component), and the
release sidecar tarball is still emitted so the workflow assertion stays
green.

Node cannot dlopen from memory, so "builtin" means embed-then-extract, the
same pattern `standalone/assets.ts` already uses for package assets. The
six-platform embed costs ~0.9 MiB packed; each machine installs only its own
`process.platform/arch` file, so one artifact stays portable.

Related: [build flavors via buildconfig.json](./2026-10-11-build-flavors-buildconfig.md)
defines the component/flavor contract this extends.

## Alternatives considered

- Embed always, drop the download path: rejected — `minimal` exists precisely
  to ship a small artifact; deleting its fallback removes the reason to have
  the components.
- Silence the 404 instead of embedding: rejected — hides a real signal (e.g.
  release pipeline failing to upload the tarball) and keeps the
  network-at-first-run dependency for unreleased builds.
- Download only the current platform at build time: rejected — the release
  builds one `nanopi.js` for all OSes; per-platform embedding at build time
  would fork the artifact per runner.

## Consequences

- Benefit: `full` single-file installs work fully offline with zero stderr
  noise (verified: sandboxed agent dir, hashes match sources, no warning).
- Cost: `nanopi.js` grows ~0.9 MiB packed; the manifest/github URL code stays
  as dead weight for `full` but live fallback for `minimal`.
- `test/standalone.test.ts` covers builtin install/skip/repair/platform-filter/
  checksum-mismatch; the real full+minimal builds were smoke-built.
