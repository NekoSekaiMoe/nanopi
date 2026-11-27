# Agent Note: One recall_context tool owns three compaction ref formats

Status: implemented

Ref: shinytale/nanopi#832

Superseded on module topology by [One compaction module owns all recall strategies](../../implemented/simplification/2026-11-27-one-compaction-module.md). The single-tool contract below still holds; the four-module layout does not.

## Problem

Three built-in modules registered `recall_context` independently: `codex-compaction` for Key Facts refs (`c0r2`), `context-recall` for citation tags (`[rN]`), and `compaction-recall` for replaced-region ordinals (`E3`). The registry resolves a duplicate tool name by load order, so `codex-compaction` won and `DefaultResourceLoader` turned the other two registrations into startup errors:

```
Error: Failed to load extension "compaction-recall": Tool "recall_context" conflicts with codex-compaction
Error: Failed to load extension "context-recall": Tool "recall_context" conflicts with codex-compaction
```

A generic loader change would weaken a check that names real mistakes (two unrelated modules reaching for the same verb). The collision is specific: these recall strategies write different ref syntaxes, and a model should have one tool for all of them.

## Decision

The first fix added a hidden `context-recall-coordinator` module to own the single `recall_context` tool while the three writers stayed registered. That layout has since been folded into one module; the writer/resolver split below remains the internal contract:

- `codex-compaction` still writes the `## Key Facts` block. `findEntryIdForRef()` moved from its `index.ts` into `compact.ts` so the reader stays next to the writer.
- `context-recall` is now a resolver-only module: `resolveRecalledEntries()` is its public surface.
- `compaction-recall` still writes the `## Replaced Context (recallable)` appendix and resolves `E<n>` refs. Its old tool and renderer are gone.

The coordinator takes one `ref: string` and dispatches on shape: `[rN]` citations append a `context_recall` entry (the `[rN]` strategy's durable-history rule), while Key Facts and `E<n>` refs answer with projected session text as a tool result, as they did before. A ref using two shapes, or an unrecognized shape, is refused instead of guessed. The 25% context-window ceiling applies to all three.

The coordinator was initially a separate build component (`module/context-recall-coordinator`). The trimmed `base` and `minimal` flavors disabled it along with the two optional recall writers. The later simplification removed those switches with the separate modules.

## Alternatives considered

- **Give each recall tool a distinct name.** Removes the collision mechanically, but leaves the model to pick among three near-identical tools by ref shape while the summary already names the shape. One tool that reads the ref it was given is a smaller contract.
- **Make the loader allow duplicate tool names and merge implementations generically.** The registry already has a first-wins rule, and a generic merger would have to invent an argument schema and dispatch policy for every collision. This case has one shared ref-shaped argument and three known resolvers; keeping the policy in a module leaves the loader's conflict diagnostic useful elsewhere.
- **Pick one recall strategy and delete the other two.** Would lose real behavior each strategy owns: durable recalled entries, stable Key Facts refs that survive renumbering, and a per-turn region table with a token cap. They are complementary views of the same compacted history.

## Consequences

- The tool's parameter shape changed from `refs: number[]` and `ref: string` variants to a single `ref: string`. Sessions that call it through the model use the ref printed in the summary, so no session-data migration is needed.
- `[rN]` recall still appends an entry; Key Facts and `E<n>` recall still return a tool result. Unifying the tool name does not unify the two delivery policies, because the `[rN]` design treats recalled text as history that must survive the next compaction.
- Startup no longer reports two false errors. A genuine collision between two unrelated built-in modules is still reported by `detectModuleConflicts()`.
- A build that enables `module/context-recall-coordinator` but disables one of the three writer modules still exposes the corresponding ref branch; it simply finds no summary written in that format. Enabling the coordinator without any writer leaves a tool that reports an unknown ref.

## Verification

- `packages/coding-agent/test/context-recall-module-conflict.test.ts`: loads the three modules through `DefaultResourceLoader`, asserts no diagnostics and one tool owner, and resolves a Key Facts ref through the shared tool.
- `packages/coding-agent/test/compaction-recall.test.ts`: resolves an `E<n>` ref through the coordinator.
- `packages/coding-agent/test/suite/agent-session-context-recall.test.ts`: drives a `[rN]` tool call end to end and asserts the recalled text returns as a `context_recall` entry.
