# Agent Note: Mutual exclusion of apply_patch and edit, and prompt surface trim

Status: implemented

## Problem

Two model-facing surfaces carried duplicated weight:

1. On Codex-impersonated APIs (`openai-responses`, `openai-codex-responses`), the
   pi-fake-codex `apply_patch` alias is a full clone of the built-in `edit` tool
   (same schema, execute, renderer). The API-scoped sync only toggled
   `apply_patch`, never `edit`, so those models received two near-identical tool
   declarations (~2.3 KB), two entries in the `<tools>` prompt section, and two
   sets of four near-identical guideline bullets in `<rules>` — the exact-string
   dedup in `buildRules` cannot collapse them because the wording differs by
   tool name. Measured: 3244 B of prompt sections plus the duplicate
   declaration, ~450 wasted tokens per request, plus model ambiguity between two
   equivalent editing tools.
2. The default system prompt carried 2592 B of fixed sections on every request.
   The `<docs>` section (1196 B, 46% of the prompt) inlined a topic-to-file map
   that duplicates `docs/index.md`, and the edit tool's usage contract was
   stated four times: the declaration description, the `edits` and `oldText`
   schema descriptions, and four `<rules>` bullets.

## Decision

- `apply_patch` declares `prepareLoadout` returning
  `{ hiddenDeclarations: ["edit"] }` whenever `edit` is in the declared set.
  Exactly one editing tool is model-visible on Codex APIs: `edit`'s declaration
  and its prompt snippet/guidelines drop out, while `edit` stays registered,
  active, and callable (a stray `edit` call still executes). No bookkeeping:
  the hook only runs while `apply_patch` is in the active set, so undeclaring
  `apply_patch` (non-Responses model, or explicit user deactivation) restores
  `edit` automatically.
- The `<docs>` section points at the README, `docs/index.md`, and the examples
  directory; it keeps the cwd-vs-install-dir path-resolution rule and the
  read-completely/follow-cross-references rule, and drops the inlined topic
  map. Paths are still printed unconditionally in flavors without docs
  (string formatting only, unchanged from before).
- The edit tool keeps its full usage contract in the declaration description
  (unique, non-overlapping, merge nearby, no padding) plus tightened schema
  descriptions; `<rules>` carries two routing bullets. The alias mirrors the
  two bullets and inherits the declaration description. The other built-in
  tools were already in this shape (one-bullet guidelines); edit stops being
  the outlier.

Measured after: default prompt 2592 → 1751 B (~648 → ~438 tokens); Codex-API
prompt 3244 → 1779 B; edit declaration 1148 → 901 B and not sent at all on
Codex APIs; total Codex-API saving ≈ 2.9 KB (~720 tokens) per request.

## Alternatives considered

- **`setActiveTools` swap inside the sync handler** (remove `edit` when adding
  `apply_patch`, restore on switch-away, with a `removedByUs` flag each way):
  symmetric with the existing sync code, but `edit` would leave the active set
  and become uncallable (`_getCallableTools` filters by the active set), so a
  stray `edit` call would fail at the provider; and it doubles the flag
  bookkeeping. `hiddenDeclarations` reaches identical model-facing behavior
  while keeping `edit` callable and the transcript/`/tree`/resume shape
  unchanged.
- **Keep both declared and only dedupe the guidance** (normalize bullet wording
  so `buildRules` collapses them): saves less than half the tokens and still
  leaves two identical schemas competing for the model's choice; the
  requirement was that only one survives.

## Consequences

- Codex-API models see exactly one editing tool; tool-choice ambiguity between
  `edit` and `apply_patch` disappears.
- A model that emits an undeclared `edit` call anyway still gets a working
  execution path on Codex APIs.
- Finding a specific doc topic now costs one extra hop: the model reads
  `docs/index.md` first instead of jumping straight to e.g. `docs/tui.md` from
  the prompt. Accepted: it only affects nanopi-self questions.
- Removing the edit guidance bullets from `<rules>` relies on the declaration
  description carrying the contract; if edit quality regresses (non-unique or
  overlapping `oldText`), the first place to look is the declaration/`<rules>`
  split, not the edit engine.
- The smaller prompt lowered the projected-context estimate below a
  threshold-compaction test's 2,000-token window (it was riding on the old
  docs section for ~130 tokens). The test's older history is now sized like
  its sibling's prompt so the threshold is crossed independently of the
  system prompt's size.
- The alias's two guideline bullets are hand-mirrored strings
  (`editToolSystemPromptContribution` is not exported from the package root;
  an export was not added just for this). The unit test pins the declaration
  inheritance so the contract cannot drift silently.
- `vitest.base.ts` gained an `@earendil-works/pi-coding-agent` alias
  (mirroring the tsconfig paths) so first-party tests can import extra
  sources directly.
- Verification: `test/pi-fake-codex-apply-patch.test.ts` covers the
  mutual-exclusion hook and the alias construction; `test/system-prompt.test.ts`
  covers the trimmed docs section and the hidden-tools prompt behavior.

Related: [bundled extras](../feature/2026-10-11-bundled-extras.md),
[build flavors](../process/2026-10-11-build-flavors-buildconfig.md).
