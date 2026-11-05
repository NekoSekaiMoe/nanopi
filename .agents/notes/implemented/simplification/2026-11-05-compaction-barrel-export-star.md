# Agent Note: Keep the compaction barrel on `export *` and hold its cost with the entry graph

Status: implemented

## Problem

`core/compaction/index.ts` had been turned into a hand-written whitelist of names while splitting
the internal barrels for the `./modules` and `./ui` budgets. The whitelist dropped
`getSummarizationFailure`, and nothing failed: only `compaction.ts` and `branch-summarization.ts`
call it, and both import the source file, so no test reached the barrel. Green `pnpm run check` and
a full test run did not mean the export surface was unchanged.

The premise behind the whitelist was also false. `export *` reached 181 files not because of the
export syntax but because of two long chains, and both were cut separately: `pi-ai`'s root barrel no
longer reaches `compat.ts` (the 111 `<provider>.models.ts` files), and the summarizer renderers moved
behind lazy `import()`. On `main`, `export *` reaches 19 files, the same as the whitelist.

## Decision

`core/compaction/index.ts` re-exports its three modules with `export *`. Nothing else is listed by
hand, so a new export in `compaction.ts` / `branch-summarization.ts` / `utils.ts` is public here by
construction and cannot be forgotten.

The cost of the barrel is a number in `scripts/check-entry-graphs.mjs`, not a property of the export
line: `core/compaction/index.ts` is budgeted at 20 files (now 19) and must not reach
`modes/interactive/`, `core/session-manager.ts`, or `pi-ai/src/providers/`.

`findViolations(budgets)` is exported from that script for the same reason the checks moved behind a
function: `packages/coding-agent/test/compaction-barrel-exports.test.ts` pins both halves without
running the CLI. It reads the barrel and asserts the three `export *` lines, then runs the budget.
A whitelist reintroduced by hand fails the first assertion; a new import that drags the session
manager in fails the second, with the violating file names.

## Alternatives considered

**Keep the whitelist and add a diff check.** The idea was to compute "source exports minus whitelist"
in a script. Rejected for two reasons. It is a check that exists to compensate for a form that is
strictly worse: `export *` cannot drift, so there is nothing to check. And it still fails the case
that started this loop, because `export type` names are erased before Node sees them, so a runtime
export diff only proves the value half; the type half needs the TypeScript compiler, which the
scripts are not allowed to depend on.

**Widen the whitelist instead of removing it.** Same cost, same audit burden, no benefit: the
whitelist was not keeping the graph small (both forms reached 19 on the current `main`).

## Consequences

- A reader of the barrel learns what the barrel offers by walking one directory, not by trusting a
  list. The 50 public names (34 values + 16 types) are whatever the three files export today.
- Reintroducing a whitelist to "trim" the barrel now fails a test rather than passing silently.
- The graph budget is the only thing standing between this barrel and the session file I/O; when a
  summarizer legitimately needs more, split the module rather than raise `maxFiles`.
- `scripts/check-entry-graphs.mjs` now has a callable entry (`findViolations`) in addition to the
  CLI, so budget behavior can be asserted in tests. The CLI still exits non-zero on violations.
