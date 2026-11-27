# Agent Note: One compaction module owns all recall strategies

Status: implemented

Ref: shinytale/nanopi#832

## Problem

PR #833 fixed the `recall_context` startup collision by adding a hidden `context-recall-coordinator` module while leaving `codex-compaction`, `compaction-recall`, and `context-recall` as three registered modules. The tool was shared, but the build still carried four module components, four bundle entries, and three flavored switches whose only job was to keep the coordinator in sync with the writers they accompanied. The user asked to merge the three modules into one compaction module with internal responsibilities.

## Decision

Only `codex-compaction` is now a registered built-in module. Its directory owns every part of compaction and recall:

- `compact.ts` still runs the Codex-style summarizer and writes the `## Key Facts` block.
- `recall.ts` appends the `## Replaced Context (recallable)` appendix and resolves `E<n>` refs.
- `citations.ts` parses `[rN]` tags and their `<refs>` block.
- `recall-tool.ts` registers the single `recall_context` tool and dispatches by ref shape.
- `index.ts` registers one `session_before_compact` handler: on the first pass it summarizes; on the second pass, when `replacedSummary` exists, it appends the region table to whatever summary won. This preserves the two-pass contract that made a rewrite handler possible.

`module/compaction-recall`, `module/context-recall`, and `module/context-recall-coordinator` are removed from `BUILTIN_MODULES`, `buildconfig.json` components, module bundles, and the trimmed flavors. Removing independent switches is intentional: recall is no longer an optional neighbor of compaction, it is part of the one module.

The tool contract is unchanged: one `ref: string`, `[rN]` citations append a `context_recall` entry, and Key Facts / `E<n>` refs answer with projected session text. The 25% context-window ceiling still applies.

## Alternatives considered

- **Keep four registered modules and only share the tool.** This was the PR #833 state. It works at runtime, but leaves readers and flavor authors to coordinate separate modules whose summaries and resolver branches are only meaningful together.
- **Merge the tool and resolvers into `index.ts`.** Removes files, but makes the already event-heavy module entry own three parsers, three projection policies, and a TypeBox schema. Keeping one file per responsibility makes the ref shapes inspectable without reading the registration code.
- **Keep the old module names as aliases.** Would preserve callers built on module names, but the only callers were in-tree build wiring and tests; keeping aliases would reintroduce the four-component graph this change removes.

## Consequences

- Startup has one compaction module and one `recall_context` owner. Duplicate tool-name diagnostics stay available for unrelated modules.
- Build flavors no longer need a coordinator switch. A flavor that drops `module/codex-compaction` drops compaction and all recall together.
- The summary formats and session entry format are unchanged, so existing sessions still resolve their refs.
- Tests now import `packages/coding-agent/src/modules/codex-compaction/recall.ts` and `packages/coding-agent/src/modules/codex-compaction/citations.ts` instead of the two deleted module directories.

## Verification

- `pnpm run check`
- `node ./test.mjs`
- `packages/coding-agent/test/builtin-modules-startup.test.ts` loads the built-in set with no startup errors.
- `packages/coding-agent/test/context-recall-module-conflict.test.ts` asserts `codex-compaction` is the sole `recall_context` owner.
