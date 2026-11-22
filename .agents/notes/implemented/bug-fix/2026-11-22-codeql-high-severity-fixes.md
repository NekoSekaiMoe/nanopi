# Agent Note: CodeQL high-severity fixes for workflow, tool arguments, and scripts

Status: implemented

## Problem

CodeQL reported three actionable findings in `shinytale/nanopi#796`:

- `.github/workflows/checks.yml` did not declare `permissions`, so `GITHUB_TOKEN` inherited the repository default (potential write scope) even though every step is read-only.
- `mergeStreamingArgumentObject` in `packages/ai/src/api/openai-completions.ts` assigned provider-controlled keys with `target[key] = value`. `Object.entries(JSON.parse(...))` keeps `__proto__` as an own key; assigning it to a fresh object invokes the `__proto__` setter and mutates the target's prototype. Tool-call argument objects from MiniMax-style streams were affected.
- `normalizeScriptValue` in `packages/tui/src/latex.ts` used `/\s*([=+-])\s*/g`; on long whitespace runs around an operator the quantifiers backtrack quadratically. Script values come from user LaTeX input.

## Decision

- Declare workflow-level `permissions: contents: read`. No step needs more; `checks.yml` only checks out code and runs local checks.
- For `__proto__`, `constructor`, and `prototype` keys in streamed argument objects, write with `Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })` and skip the normal assignment/merge path. This preserves them as own data properties without triggering prototype setters. Nested values are inserted as-is, matching the old behavior for ordinary keys.
- Replace the regex in `normalizeScriptValue` with a linear split on capturing `(\s*[=+-]\s*)` groups and `trim()` only those operator separators. Whitespace between words is preserved; whitespace adjacent to an operator collapses as before.

## Alternatives considered

- Skip dangerous keys entirely: rejected — a tool argument named `__proto__` can be legitimate JSON data (the repo already has classifier tests that require `__proto__` as an own answer key); dropping it would silently lose provider data.
- Use `Object.create(null)` for argument objects: rejected — these objects are later serialized and spread into assistant messages; changing their prototype affects equality checks and consumers.
- Keep the regex but bound the whitespace: rejected — an arbitrary input would still be O(n²), and a bound changes rendering behavior for long spaces.

## Consequences

- `checks.yml` runs with a read-only token; GitHub workflow lint and the existing checks pass.
- Prototype-sensitive argument keys stay as own properties; no global prototype pollution from streaming tool calls.
- Script normalization stays linear on adversarial whitespace.
- Regression tests live in `packages/ai/test/openai-completions-nonstandard-stream-shapes.test.ts` and `packages/tui/test/latex.test.ts`.
