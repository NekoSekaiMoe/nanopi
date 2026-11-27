# Agent Note: Meat is a git diff mode, not a second tool

Status: implemented

Ref: shinytale/nanopi#870

## Problem

Issue #852 had already collapsed four git commands into one `git` tool, but two tools still read a git diff: `git action=diff` returned a capped raw patch, and `meat` returned a faithful reading diff compiled from a subagent's line-coordinate plan. Issue #870 asked to merge them.

The cost is not just one more name in every request's tool list. The two tools have overlapping inputs (repo cwd, diff scope) but different output contracts, so a model has to choose between "raw" and "reading" before it knows how big the diff is. Keeping a separate `pi-meat` module also meant a second build component and a second vendored subtree for the same compiler.

## Decision

`git action=diff` takes `mode=raw` (default) or `mode=reading`. Raw keeps the old byte cap and `--stat` prefix. Reading runs the former meat flow: spawn a subagent per chunk, parse its submitted edit plan, and compile the plan deterministically so every kept line is verbatim from the original diff. The compiler, chunker, rubric, import mask, and string-enum helper move into `pi-git-tools/src/vendor/`. The `meat` tool, the `pi-meat` module, its `module/pi-meat` build component, bundle entry, and vendored-path exclusions are removed; `full` loses one module and base/minimal lose one false switch.

The reading cache moves from `~/.nanopi/agent/cache/pi-meat` to `~/.nanopi/agent/cache/pi-reading-diff`, keyed by the unchanged `COMPILER_REV` and chunk hash. A session that remembered `meat` sees only `git` with the two diff modes.

## Alternatives considered

- **Keep `meat` as a separate tool and only make `git action=diff` call it internally.** Rejected: the tool name and schema would still be paid on every request, and the model would still face the same two-name choice the user asked to remove.
- **Make `git action=diff` always return the reading diff.** Rejected: reading requires `pi-subagent-mini` and can take minutes. Raw diff is the bounded, always-available fallback and must stay the default in builds without subagents.
- **Move the compiler into `pi-git-tools/src/` as first-party code.** Rejected: the files are a port of show-me-the-meat with documented simplifications; keeping them under `vendor/` preserves that origin and leaves the existing `biome`/`tsconfig`/import-check exclusions grouped under one module.

## Consequences

- Active tools drop by one. The `git` schema gains `mode` and `force`; `abridge` is removed. The reading path now reports a missing-subagent error instead of silently downgrading to raw.
- `packages/coding-agent/test/pi-extensions-port.test.ts` imports the chunker from the new location. `packages/coding-agent/test/tool-merge.test.ts` asserts no `meat` tool is registered and that reading mode fails clearly without a subagent.
- Cache entries from the old `pi-meat` directory are not migrated; a cold cache only costs one extra subagent pass.

## Verification

- `pnpm run check`
- `node ./test.mjs`
- `packages/coding-agent/test/tool-merge.test.ts` and `packages/coding-agent/test/pi-extensions-port.test.ts` pass.

The [git and web merge note](../simplification/2026-11-27-git-and-web-tool-merge.md) (issue #852) owns the one-name-per-capability decision. This note supersedes its split between raw git diff and meat.
