# Agent Note: TUI sidecar tarball is mirrored to AtomGit, and the release builds it

Status: implemented

## Problem

`full` stopped embedding the native sidecars (#534), so every install of the
published `nanopi.js` downloads `nanopi-sidecars-<version>.tgz` on first use.
The bundle's manifest named exactly one URL for it, a GitHub Releases asset:

```
https://github.com/NekoSekaiMoe/nanopi/releases/download/v<version>/nanopi-sidecars-<version>.tgz
```

That file is the only source of the TUI native prebuilds (clipboard, modifier
keys), and GitHub Releases is the one host readers in mainland China cannot
reach — the reason the AtomGit mirror exists at all. The mirror carried the
three bundles and nothing else, so the download that #534 made load-bearing
was unreachable exactly where it needed a mirror.

Two smaller holes in the same path: the nightly workflow never collected the
tarball the single-file build emits next to `nanopi.js`, and
`build-binaries.yml` deleted it in "Prepare GitHub release payload" without
copying it, so the `test -f nanopi-sidecars-<version>.tgz` assertion after
that deletion could only fail.

## Decision

The tarball is a first-class release asset on both hosts, and the artifact
names every host it can use.

- `scripts/publish-atomgit.mjs` publishes `nanopi-sidecars-*.tgz` found in
  `--input` next to the bundles: same `assets/<tag>/` directory, listed in
  `SHA256SUMS`, named in `README.md` and in the generated nightly notes. It is
  optional for the script (a release recovery without it still publishes the
  bundles) but the workflows treat a missing one as an error.
- `SidecarSource.url` became `urls: string[]`, tried in order; the first
  success wins and the failures are concatenated into the single stderr
  warning. Serial, not racing: the later entries exist because a host is
  unreachable for some readers, not to be faster.
- The TUI entry of the manifest carries three URLs: GitHub Releases, then
  AtomGit `v<version>`, then AtomGit `nightly`. The name embeds the TUI
  package version, which is what decides the bytes, and the version is
  identical in a release and a nightly build. `v<version>` is the exact tag
  for a released version; `nightly` covers a build whose version has not been
  published yet (GitHub 404s for those too, before #534 made it consequential).
- `nightly.yml` moves the tarball the `full` build emits
  (`packages/coding-agent/binaries/`, removed before the smaller flavors run
  so the same name is not produced twice) into `release-assets/`, checks it
  contains a `.node` file, and smoke-tests every bundle with a fresh `HOME` so
  the download path runs instead of being skipped by an install from the
  previous bundle.

## Alternatives considered

- **Keep GitHub as the only source and document the workaround.** Rejected:
  "download the tarball by hand from a host you cannot reach" is not a
  workaround. The prebuild is the difference between native clipboard support
  and shelling out to `wl-paste` / `xclip` on every copy.
- **Race the mirrors and take whichever answers first.** Rejected: the
  fallback is about reachability, not latency, so it would buy milliseconds at
  the cost of downloading a tarball twice whenever the loser finishes first.
- **Pick the mirror order at build time from the target platform.** Rejected:
  the release builds one artifact for every OS, and the user's network is not
  a property of the platform anyway.
- **Embed only the current platform's prebuild** (the #534 alternative, again):
  rejected for the same reason there — one artifact serves every OS, so
  per-platform embedding forks it per runner.
- **Point the nightly at the release tag instead of `nightly`.** Rejected:
  a version that has never been released has no tag, and that is precisely
  the build whose `full` bundle most needs a working URL.

## Consequences

- A reader who cannot reach GitHub now gets the native prebuilds from AtomGit
  instead of a warning. The cost is one extra file (~60 KiB) per published
  tag, plus one 404 per fallback step when a host is down.
- The manifest type change is internal to the single-file runtime; npm
  installs never build a manifest, and `resetSidecarManifestCache()` exists
  only so tests can install the manifest more than once per process.
- Verification: `scripts/publish-atomgit.test.mjs` asserts the tarball and its
  checksum line land in `assets/<tag>/` and both documents name the URL, and
  that a payload without it still publishes the bundles;
  `packages/coding-agent/test/standalone.test.ts` drives `ensureSidecars`
  against a local HTTP server — first mirror 404 → second used and installed,
  every mirror dead → one warning naming both URLs and the file.
  The real AtomGit URLs are only exercised by the first published tag.

Related: [`full` stops embedding the native sidecars](2026-11-06-sidecars-download-in-full.md)
(the change that made the download load-bearing), [bundle 发到 AtomGit 的发行仓库](2026-11-05-atomgit-release-assets-mirror.md)
(the repository this extends), [Single-file nanopi.js release artifact](2026-10-11-single-file-release-artifact.md)
(where the tarball comes from), [buildconfig-gated builtin sidecars](2026-10-11-sidecar-builtins.md)
(the manifest and builtin payload this adjusts).
