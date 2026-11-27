# Agent Note: mirror follows source main when CI checkout is stale

Status: implemented

## Problem

Build `cnb-sj4-1k8drdrd2` failed in `mirror main and tags` for merge commit
`059f2f482` (PR #847). Twenty-four seconds later, `23daa7a55` (PR #845) landed on
source `main` and its mirror run reached GitHub first. The first job still held
the `059f2f482` tree. The mirror fetched the GitHub tip (`23daa7a55`) and its
no-revert guard saw five `packages/coding-agent/src/core/compaction/*.ts` files
that existed there but not in the stale checkout tree, so it refused to push.

The guard was correct: pushing the checkout tree over the newer GitHub tree
would silently drop those five files. The defect was the input: the mirror used
the pinned CI checkout as the source-of-truth tree even when source `main` had
moved on.

## Decision

`scripts/mirror-main.mjs` refetches the source branch into `FETCH_HEAD` when the
workflow supplies `MIRROR_SOURCE_REMOTE`. If `HEAD` is a strict ancestor of that
source tip, the mirror uses the source tip tree instead of the stale checkout. A
diverged checkout is unchanged: it still goes through the content-based
no-revert guard before any synthetic commit is pushed.

Both workflows provide the source URL. CNB uses `CNB_REPO_SLUG`; GitHub Actions
uses `github.repository`. Only the source URL is passed. Target credentials stay
in `mirror.mjs`, and the refetch uses the same timeout and retry path as the
target fetch.

## Alternatives considered

- Rerun the failed build and close the issue without a code change. Current
  `main` already contains `23daa7a55`, so one rerun would likely pass, but any
  two back-to-back merges could reproduce the same failure.
- Keep the checkout as the source of truth and weaken or skip the no-revert
  guard. That is the silent content loss from #242 and #235 reintroduced.
- Merge the fetched source tip into the checkout before pushing. This creates
  merge commits in the advertised push range and reintroduces the push
  protection problem recorded in the earlier mirror notes.
- Detect only the five missing files and patch around them. That hardcodes one
  race's file list and cannot generalize to the next pair of merges.

## Consequences

- Back-to-back merges converge even when the older job's mirror reaches the
  target after the newer job's mirror.
- A stale checkout that is an ancestor of source `main` is no longer a content
  conflict. A stale checkout that is not an ancestor still fails closed.
- One extra source fetch occurs in each CI mirror run. If the source branch is
  unreachable, the mirror fails before touching the target instead of pushing
  a stale tree.
- Regression coverage: `scripts/mirror-main.test.mjs` reproduces a detached
  HEAD pinned to the old commit while source `main` contains a file the old tree
  lacks. All 20 mirror tests pass; `pnpm run check` passes.
