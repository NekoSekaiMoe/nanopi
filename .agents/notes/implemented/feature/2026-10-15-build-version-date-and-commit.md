# Agent Note: Build version as date plus short commit, and folded directory paths

Status: implemented

## Problem

Two welcome-box complaints from the same session (issue #13):

1. The version reads `v20261013.0.0` — the date alone, from the lockstep
   package.json version. Nothing distinguishes builds made the same day, and the
   `.0.0` suffix carries no information the user asked for.
2. The `directory:` row truncated long paths at the tail:
   `directory: ~/verylongdirectoryname/anotherlongsegm…`. The directory the
   user is working in — the last segment — is exactly what disappears, while
   the head that repeats the home prefix stays.
3. The row said nothing about which branch is checked out, which is the first
   thing you want to know about a directory you are working in.

## Decision

The version becomes `v<date>.<short-commit>`, e.g. `v20261013.718adde`, and the
directory row folds in the middle and carries the branch suffix.

- `packages/coding-agent/src/core/build-version.ts` owns the format:
  `dateFromVersion()` extracts the `YYYYMMDD` prefix (non-date versions pass
  through, so `0.99.0` still renders as `v0.99.0`), `formatBuildVersion()`
  appends the first seven hex characters of the commit, and `BUILD_VERSION` is
  resolved once at module init. The commit comes from, in order:
  - `NANOPI_BUILD_COMMIT`, the full HEAD sha injected by
    `scripts/build-coding-agent-bundle.mjs` and
    `scripts/build-coding-agent-single-file.mjs` as an esbuild define, next to
    the existing `NANOPI_BUILD_COMPONENTS`/`NANOPI_BUILD_FLAVOR` defines;
  - otherwise `git rev-parse --short=7 HEAD` in `process.cwd()`, which is what
    source checkouts and npm installs get, with a 1 s timeout and no throw.
    Outside a repository the commit is simply absent.
- Consumers show the same string: the welcome box title (`π NanoPi
  v20261013.718adde`, the `v` moved out of the component so the component owns
  the whole label), `/status`'s dialog title, and `nanopi --version`.
  `InteractiveMode.version` and the config `VERSION` stay untouched — they
  still drive changelog gating, install-change detection, bug reports, and the
  User-Agent, where the exact package version is the correct identity.
- `welcome-box.ts` exports `foldMiddle(text, maxWidth)`: it keeps
  `ceil((maxWidth - 1) / 2)` visible columns from the head, one `…`, and the
  rest from the tail, using `sliceByColumn` from `@nanopi/pi-tui` so wide
  characters and ANSI codes are never cut in half. The directory row folds to
  `inner - 11` (the width of `directory: `) and then goes through the existing
  `fitRow` padding, so the box border stays aligned.
- The directory row also appends the current git branch
  (`~/a/…/d (main)`). The branch comes from the `FooterDataProvider` the footer
  already owns, so the welcome box inherits its HEAD/reftable watchers and
  re-renders on branch switches instead of caching a startup value. Outside a
  repository, or on a detached HEAD, the suffix is omitted. The branch rides
  along in the fold: the path plus ` (branch)` is folded as one string, so a
  long path gives up its middle rather than its branch.

Supersedes the version/title details in
[codex-welcome-footer-status](2026-10-11-codex-welcome-footer-status.md); that
note's layout decisions still hold.

## Alternatives considered

- Read the commit at runtime only, no build-time define: rejected — the
  single-file artifact is built from a source archive with no `.git` directory
  (see [single-file artifact](../process/2026-10-11-single-file-release-artifact.md)),
  so it would always report the cwd's repository, i.e. whatever the user
  happened to launch it from. The define is what makes the artifact
  self-describing.
- Bump the package.json version per commit (`<date>.<n>.0` on every merge):
  rejected — it breaks lockstep versioning, the release flow in
  `.agents/skills/release.md`, and the tag/package-version check in
  `create-source-archive.mjs`, all for a string that git already knows.
- Truncate the directory row from the head instead (`…/nested/finalproject`):
  rejected — it keeps the current directory but loses the anchor that says
  which checkout of the tree this is; both ends are cheap to show.

## Consequences

- Benefit: builds from the same day are distinguishable, a version string maps
  to exactly one commit, and the directory row stays useful in deep paths and
  names the branch it points at.
- Cost: every unbundled start spawns one `git rev-parse` (~5 ms); bundled
  artifacts pay nothing. `--version` output changes shape, so anything parsing
  it as strict semver (only `scripts/coding-agent-smoke.mjs`'s equality check
  against the manifest version) needs to compare against the package version
  instead.
- Testing: `test/build-version.test.ts` covers date extraction, short-commit
  slicing, the no-commit fallback, and the repository lookup;
  `test/status-command.test.ts` covers the folded row (both ends kept, box
  width respected, short paths untouched).
- The branch suffix is dropped, not rendered as `detached`, when the checkout
  has no symbolic HEAD: the row answers "where am I", and a bare `detached`
  label spends its width on the one state where the user already knows.
