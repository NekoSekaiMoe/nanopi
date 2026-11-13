# Agent Note: nightly publishes the TUI sidecar again, and the mirror is a tested contract

Status: implemented

## Problem

#536 made `nanopi-sidecars-<version>.tgz` a release asset, carrying the TUI
native prebuilds that `full` no longer embeds. It never shipped: from
2026-11-07 to 2026-11-09 the nightly run failed in `Collect TUI native
prebuilds` every day, `Build bundle and image` died before
`Upload bundles`, and both downstream jobs were skipped — the npm package to
GitHub Packages and the bundles plus tarball to AtomGit. That is the channel
added for readers who cannot reach GitHub, so the failure undid the reason the
mirror exists.

Two independent defects, both in the same value:

1. `build-coding-agent-single-file.mjs` wrote the tarball to
   `dirname(outputFilePath)`. `--out` names a **file**, and the nightly job
   points it at `release-assets/nanopi-<flavor>.js`, so all three flavors wrote
   the same-named tarball into `release-assets/` (overwriting each other). The
   nightly step then globbed `packages/coding-agent/binaries/`, where nothing
   had been written, and its "expected exactly one tarball, found 0" check
   failed. `build-binaries.yml` survived only because it passes `--out` as a
   directory, i.e. it has the same shape as the default.
2. The mirror URLs the manifest bakes in (`atomgitSidecarTarballUrls`, from
   #536) had no test. Nothing checked that a bundle knows where its own
   tarball is, so the one channel the mirror exists for was unverified.

A third defect came from the fix itself and surfaced on the next release
(2026-11-14): the tarball was placed next to `defaultOutput`, which is derived
from the script's own `repoRoot`. The release job builds from an extracted
source archive, so `repoRoot` is a `mktemp -d` tree: the tarball landed there
and the step's `trap` deleted it. `Prepare GitHub release payload` then failed
on a bare `test -f nanopi-sidecars-<version>.tgz` with no output, which is why
the release run pointed at a missing file rather than at the build.

A fourth question was open when the issue was filed: whether AtomGit's
`/raw/main/<tag>/<file>` still serves bytes rather than an HTML page. Probed
from a mainland China IP on 2026-11-10 (`curl -sSL
https://atomgit.com/nanopi/releases-assets/raw/main/nightly/nanopi.js`,
`.../nanopi-sidecars-20261107.0.0.tgz`, and the same paths on
`gitcode.com`): all of them return status 200 with `text/html` and a ~6 KiB
`<title>AtomGit - 全球开发者的开源社区…</title>` document. The platform now
interposes its export-control landing page on anonymous raw reads. So the
mirror URLs are correct by construction but currently serve no bytes to an
unauthenticated `curl`, and this repo cannot fix that.

## Decision

The tarball has exactly one home in the build tree, independent of `--out`:

- `build-coding-agent-single-file.mjs` writes it to the agent bin directory
  and stages it there. The destination is `--sidecars-out <dir>`, defaulting to
  `defaultOutput`'s parent (`packages/coding-agent/binaries/` of the checkout
  the script lives in). The name carries the TUI version, not the flavor, so
  there is one tarball per build and every flavor emits the same bytes; a
  flavor must never decide where it lands.
- A caller that builds from an extracted archive must pass `--sidecars-out`:
  `build-binaries.yml` points it at `${GITHUB_WORKSPACE}/packages/coding-agent/binaries`
  for the full build (through `build-single-file.mjs`, which forwards the flag)
  and for the `base`/`minimal` loop. A default-only contract cannot express
  "the workspace, not the tree the script was copied into".
- The URL builders are named exports
  (`githubSidecarTarballUrl`, `atomgitSidecarTarballUrls`) over a
  `ATOMGIT_ASSETS_SLUG` constant, so the manifest contract is greppable and
  testable. `scripts/build-coding-agent-single-file.test.mjs` pins the path
  choice and both tag shapes.
- The nightly step dumps `ls -l` of both directories on a count mismatch.
  `nullglob` already erases the difference between "one file" and "no match",
  so the failure said `found 0` and nothing about why; the next person gets the
  layout instead of a guess.

## Alternatives considered

- **Keep writing next to `--out` and have the workflow copy from
  `release-assets/`.** Rejected: it makes the tarball's location a property of
  the caller's `--out`, and requires every caller to know it. The three flavors
  also write the same file name, so `release-assets/` would legitimately hold
  three copies and the "exactly one" check would have to be relaxed into
  "at least one", which is how the second copy hides.
- **Delete the tarball in the nightly job and regenerate it.** Rejected: the
  build step is the only thing that knows the TUI version the manifest names,
  and regenerating means uploading another build to a job that already has the
  bytes.
- **Point the manifest at AtomGit's API or the release-asset paths instead of
  `/raw/`.** Not adopted: the API answers 404 for these repos and Release
  assets have no anonymous API (see the mirror note). There is no alternative
  endpoint to switch to; the platform behaviour needs to be raised with AtomGit
  or the mirror has to move.
- **Drop the AtomGit URLs until `/raw/` serves bytes again.** Rejected for now:
  the fallback is one 404 per step on a path that is already the last resort,
  the URLs are what the release flow publishes, and removing them would need
  re-verification the moment the platform changes back.

## Consequences

- The nightly publishes again and the tarball reaches both hosts. Cost: the
  tarball is now a repo-tree artifact even when `--out` points elsewhere,
  which is the one thing the build script writes outside its output path.
- The mirror being unreachable is recorded, not fixed. Anyone re-reporting
  "the bundle cannot download its sidecar" should check the AtomGit landing
  page before touching this code; the tests and the bundle are not the cause.
- Verification: `scripts/build-coding-agent-single-file.test.mjs` (URL list,
  tarball location, and that the release workflow passes `--sidecars-out` twice),
  the existing `scripts/publish-atomgit.test.mjs` (it still
  publishes a tarball handed to it), and a local `full`/`base`/`minimal` build
  reproducing the nightly layout: one tarball in
  `packages/coding-agent/binaries/`, three bundles elsewhere, tarball contains
  six `.node` files. The GitHub-side run is only exercised by the next
  scheduled nightly.

Related: [TUI sidecar tarball is mirrored to AtomGit](2026-11-06-tui-sidecar-mirror-and-prebuilds.md)
(the change that introduced both the tarball-as-asset and the URL list),
[bundle 发到 AtomGit 的发行仓库](2026-11-05-atomgit-release-assets-mirror.md)
(why the mirror exists), [`full` stops embedding the native sidecars](2026-11-06-sidecars-download-in-full.md)
(why the download is load-bearing).
