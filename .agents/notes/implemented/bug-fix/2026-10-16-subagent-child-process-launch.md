# Agent Note: Subagent children are launched from the module registry, not source paths

Status: implemented

## Problem

`pi-subagent-mini`'s `subagent` tool runs each child as a fresh CLI process. Two
generations of that launch line had both rotted, and the failures compound
because a broken child still exits 0 often enough to look like a result.

**The argv no longer exists.** The child was launched as:

```
nanopi --mode json -p --no-session -ne --no-skills ... -t <tools> -e <entry> <task>
```

`-ne` (`--no-extensions`) and `-e` (`--extension`) were removed with the
extension-plugin system. `parseArgs` reports a single-dash unknown option as an
error diagnostic, and `main.ts` exits 1 on any error diagnostic -- so every
spawn died immediately. Worse, the *value* of the rejected `-e` also survived:
`parseArgs` only consumes the next argument for flags it recognizes, so
`-e /some/entry.ts` left `/some/entry.ts` in `args`, and `buildInitialMessage`
takes `parsed.messages[0]` as the prompt. The child's whole prompt was an
extension file path; `Task: ...` was pushed to the second message slot and
never sent.

**Children could not be handed modules anyway.** With discovery gone, the only
way a child gets functionality is `--modules` (added here) or nothing. The old
code instead guessed entry files from the extension's own location:

- `ownDir()` from `__dirname` (jiti) or `import.meta.url`
- `<sibling>/src/index.ts`
- `$HOME/.pi/agent/packages/<name>/src/index.ts`

A bundled build has no `src/` tree and nanopi's agent dir is `~/.nanopi/agent`
(never `~/.pi/agent/packages`, which does not exist), so the list came back
empty and children silently ran bare. The visible symptom was `403
FreeTierError` from OpenCode Zen: children need `pi-fake-opencode`, and the
parent session had it.

**The launcher name was stale.** `resolvePiBin()` read `package.json`'s
`bin.pi`, a key that stopped existing at the rebrand (the manifest exposes
`bin.nanopi`). The lookup returned `undefined`, the function fell back to a bare
`pi` on `PATH`, and spawns failed with `spawn pi ENOENT` on any machine without
upstream pi installed.

## Decision

The child is launched from the running process's own module registry:

- `nanopi --modules <names>` selects built-in modules by name, replacing the
  build default. Names that match nothing are dropped rather than fatal: a child
  pinned to a module its launcher does not have should still start.
- `pi.getModuleNames()` exposes the registry's module list to modules. Factories
  run before the registry object exists, so the list is the load set the caller
  is building, passed by reference; it is the full set, not just the modules
  loaded so far.
- Children inherit that list minus `CHILD_MODULE_SKIP` (`pi-ui`, `pi-rewind`,
  `ask-lite`, `todo-lite`). `mcp-lite` is included only while the extra module's
  mcp subsystem switch is on, matching the `mcp__*` tools added to the child's
  default tool list.
- The launcher is `process.execPath <packageDir>/<bin entry>`, reading the
  manifest's `bin` map under `APP_NAME` with a first-entry fallback.
- The task is the final argv element. Anything that appends a flag after it
  would swallow it, and an unrecognized flag before it would resurface as the
  prompt.

## Alternatives considered

**Keep resolving sibling source paths, but through `getPackageDir()`.** Fixes
only the bundled case, and leaves the real defect: the child launch encodes "the
package is a source checkout with an `src/` tree" into argv. A second resolution
of the same fact is what let the two copies drift apart in the first place.

**Select modules through a `NANOPI_MODULES` environment variable.** Workable,
but it invents a second module-selection mechanism next to the registry that
already answers the question, and env vars leak into grandchild processes.

**Spawn the child in-process (reuse `AgentSession`) instead of a subprocess.**
Would remove the argv surface entirely, but children need their own model,
tool set, and context window, and an in-process child shares the parent's
abort signal and event loop -- the isolation is the feature.

## Consequences

- Subagents work again on every install layout, verified end to end against a
  local faux model server: the child received `Task: say PONG` as its only user
  message, loaded the inherited module list, and returned `PONG` through the
  completion notification.
- A new built-in module automatically reaches children unless it is added to
  `CHILD_MODULE_SKIP`. That inverts the old failure mode (a hand-maintained list
  silently going stale) at the cost of a child loading a module it does not
  need; `CHILD_MODULE_SKIP` is the one place to say otherwise.
- Children of an older launcher and a newer CLI mix: unknown `--modules` names
  are dropped, so a child pinned to a retired module still starts, just without
  it. This is deliberate -- refusing to start would turn a harmless version skew
  into a hard failure.
- `--modules` is a general CLI flag, not subagent plumbing, so any caller can
  pin a module set.

## Testing

- `packages/coding-agent/test/suite/regressions/subagent-child-argv.test.ts`
  pins the child argv: no diagnostics, the task is the only message, neither a
  tool list nor an extension path becomes the prompt, and the retired `-ne`/`-e`
  flags are still rejected rather than silently ignored.
- `packages/coding-agent/test/args.test.ts` covers `--modules` parsing including
  the empty list.
- End-to-end against a local OpenAI-compatible server: subagent spawn -> wait ->
  completed report, and the captured child request body showing the task text.
