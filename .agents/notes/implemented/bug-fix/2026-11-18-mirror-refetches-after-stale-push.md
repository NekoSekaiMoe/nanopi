# Agent Note: mirror recomputes after a stale push plan

Status: implemented

## Problem

`cnb-78r-1k7l8umb2` failed in `mirror main and tags`. The script fetched GitHub
`main` at `4ca30e56`, planned a fast-forward push of `47ccc6e6`, then the push was
rejected:

```
cannot lock ref 'refs/heads/main': is at 8f209673 but expected 4ca30e56
```

A second CNB push (`8f209673`) had landed after the fetch. The retry logic treated
the rejection like a transport failure and replayed the same stale ref twice, then
exited non-zero.

## Decision

`scripts/mirror-main.mjs` now treats a non-fast-forward rejection as a stale plan:
refetch, recompute the target against the new tip, and repeat the full content
check. A stale plan is not a content conflict. The no-revert proof runs on every
recompute, so a genuinely divergent remote is still refused. No force push.

The retry budget stays at three attempts. Transport retries and stale-plan retries
share that budget. Tree equality and content-loss verdicts remain terminal and are
not retried.

## Alternatives considered

- Retry the same ref three times. That was the failing behavior: a stale plan
  cannot become valid if the remote only moves forward.
- Merge the new remote tip into local `HEAD` and push the merge. This reintroduces
  merge commits into the advertised range and defeats the push-protection design
  recorded in the earlier mirror notes.
- Disable compare-and-swap by force pushing. It would overwrite commits from the
  other mirror direction and can lose content with no trace.

## Consequences

- Back-to-back pushes to the source branch converge: the losing mirror run
  refetches and sees the tree already present, or pushes one synthetic commit on
  the new tip.
- Every retry pays one fetch plus five or ten seconds of backoff. CI logs include
  `remote main advanced during push` when this path runs.
- `scripts/mirror-main.test.mjs` adds a fixture where the remote ref advances
  between fetch and push, and asserts that the mirror converges to a no-op.

Related: [main mirror retries transport failures](2026-10-22-mirror-main-retries-transport-failures.md)
