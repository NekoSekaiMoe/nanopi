# Agent Note: Remove output compaction, keep tool output verbatim

Status: implemented

Ref: shinytale/nanopi#886

## Problem

The [pi-extensions port note](../feature/2026-11-26-pi-extensions-port.md) brought in `pi-output-compact` as the output-compaction half of rtk. Every technique in it is lossy: build/test/lint output becomes a count line, long grep output is grouped, and oversized results are truncated in the middle. It was off by default, behind `<agentDir>/output-compaction.json`, but a session that enabled it saw rewritten tool output and lost `structuredContent` on replaced results.

Issue #886 asked what the module does and whether keyword-only filtering (`success`/`error`/`failed`/`complete`) would be a safer replacement. That filter still loses the diagnostic lines that carry the cause of a failure, so the user decided to drop the feature: raw input cost is cheap enough that preserving verbatim tool output is worth more than the context it saves.

## Decision

`pi-output-compact` is removed. Its module directory, the `/output-compaction` command, the `before_agent_start` guidance that announced compaction, the `tool_result` rewrite hook, the `module/pi-output-compact` build component and bundle entry, the base/minimal false switches, and the vendored-path exclusions in `tsconfig`, `biome`, `vitest`, and the relative-import check all go with it. `--modules pi-output-compact` is no longer a valid selector. Every tool result now reaches the model as produced, with `structuredContent` intact.

The original [pi-extensions port note](../feature/2026-11-26-pi-extensions-port.md) owns the module split; this note supersedes its decision to keep an opt-in output compactor. No replacement compaction or keyword filter is added.

## Alternatives considered

- **Keep the module off by default.** Rejected: it still ships a `/output-compaction` command and a `before_agent_start` hint, and the user concluded the context saving is not worth the rewritten output even when disabled.
- **Switch to keyword-only filtering.** Rejected: `0 failed`, `no errors`, and `success: false` match the same keywords with opposite meanings, and failure causes sit in stack and assertion lines that carry no keyword. Filtering lines is still lossy and harder to reason about than leaving the output alone.
- **Compress losslessly and keep the model reading it.** Rejected: gzip bytes are not readable by the model and base64 grows the context. Externalizing the original output to a file and leaving only a summary in context would be a different subsystem; the existing `tool-result-store` already covers oversized results without rewriting them.

## Consequences

- Model-visible tool output is verbatim from `bash`, `read`, and `grep`; no technique strips ANSI codes, aggregates build/test/lint noise, groups grep hits, or truncates the middle of a result. `output-compaction.json` is no longer read.
- `/output-compaction` no longer exists. A session that remembered it sees an unknown command.
- The full build loses one module; base and minimal lose one false switch. `tool-result-store` recall is unchanged and stays the path for oversized results.
- Existing sessions with `outputCompaction.enabled: true` silently keep all output instead of a compacted version. There is no migration for the config file; it is simply ignored.

## Verification

- `pnpm run check`
- `node ./test.mjs`
