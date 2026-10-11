# Agent Note: Content-hash refresh for single-file bundled extras and assets

Status: implemented

## Problem

The single-file runtime caches in two places, both keyed by version only
(see [single-file artifact](../process/2026-10-11-single-file-release-artifact.md)
and [bundled extras](../feature/2026-10-11-bundled-extras.md)):

1. the extracted asset payload in `<cache>/nanopi/standalone/<version>`,
   skipped whenever a `.complete` marker exists;
2. the bundled-extras install in `~/.nanopi/packages/<name>`, skipped whenever
   the `BUNDLED_EXTRA_MARKER` version matches.

Development iteration rebuilds `nanopi.js` without bumping `VERSION`, so a
rebuilt payload (for example a modified vendored pi-ui editor) never reached
the cache, and a rebuilt `dist/extras` never replaced the installed extra. The
user saw the old UI after every rebuild and reasonably concluded the changes
"did not take effect".

## Decision

Both layers switch to version + content markers:

- `installBundledExtras` writes `<version>\n<sha256-of-tree>` (sorted relative
  paths plus file bytes, marker excluded) and reinstalls when either line
  changes. Old version-only markers mismatch once and migrate on the next run.
- `extractAssetsPayload` takes the payload hash and records it inside the
  staged tree as `.assets-sha256`; the new `syncAssetsPayload` extracts when
  the tree is missing, incomplete, or extracted from a different payload.

User-owned directories without a marker are still never touched, and a
same-version run with unchanged content still skips the copy, so hand edits to
an installed extra survive unless the bundled content actually changes (then
the bundle wins, by design: the directory is ours).

## Alternatives considered

- Key the cache directory by payload hash instead of version: rejected — it
  changes the on-disk layout and `NANOPI_PACKAGE_DIR` consumers for no extra
  benefit over an in-tree hash marker.
- Always re-extract and reinstall every start: rejected — hashing a few MB per
  boot is cheap, but rewriting the install every time would clobber user edits
  to marker-carrying installs and add boot I/O for nothing.

## Consequences

- Benefit: same-version rebuilds propagate to both caches; the dev loop
  (rebuild `nanopi.js`, run) works without deleting `~/.nanopi/packages` or
  `~/.cache/nanopi/standalone` by hand.
- Cost: every boot hashes the embedded payload (~6 MB base64) and each extra
  tree once; measured negligible. Hand edits to an installed extra are now
  discarded whenever the bundled content differs from the version they were
  installed from.
