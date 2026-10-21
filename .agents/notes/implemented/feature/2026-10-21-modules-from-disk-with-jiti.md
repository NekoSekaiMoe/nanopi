# Agent Note: module files on disk, loaded with jiti

Status: implemented

## Problem

`2026-10-13-remove-plugin-system-programmatic-modules.md` deleted the whole
plugin runtime, jiti included, and left one way to add behaviour: put a module
under `packages/coding-agent/src/` and recompile. That is fine for the modules
this repository ships. It is useless for a user with a 30-line module: there is
no binary rebuild in reach, and `docs/configuration.md` had to tell them that
`.nanopi/extensions/` is "a place to keep module source, not a place nanopi
loads from".

Issue #126 asks for the load path back without the plugin system: no directory
discovery rules to relearn, no package manager, no reload machinery. Just a
file that becomes a `SessionModule`.

The prior discussion in the issue considered renaming the directory to
`.nanopi/modules` and rewriting the sample modules in JavaScript. Both are
rejected here: `src/modules/` already means "compiled into the build", so a
second `modules` directory names two different layers, and `.js` would drop the
type checking that is the only thing keeping those samples honest.

## Decision

**`SessionModule = { name, factory }` stays the only contract.** `jiti-loader.ts`
produces plain objects and hands them to the same `loadModules()` everything
else goes through; the registry, the event set, and the factory lifecycle are
untouched. The new thing is where the factory came from.

**Three sources, in load order**: `$NANOPI_EXTENSIONS` (files or directories,
`path.delimiter`-separated), `<agent dir>/extensions/`, and the project's
`.nanopi/extensions/`. A directory contributes its `*.ts`/`*.js` files and one
level of `*/index.*`; a module named `foo/index.ts` is module `foo`. Package
manifests are not read: a module file is the whole contract.

**The project directory is gated by project trust.** These files are code the
project wrote, so they sit behind the same decision as `settings.json` and
project skills. The scan therefore happens inside `reload()` after the trust
decision is recorded, not in the `DefaultResourceLoader` constructor — the
constructor has no answer to "is this project trusted yet", and `reload()` is
where `resolveProjectTrust` already runs.

**One broken file is a diagnostic.** Its error lands in
`LoadModulesResult.errors` (the CLI prints it as `Failed to load extension
"<path>"`), and every other module still loads.

**jiti is lazy and build-scoped.** It is imported inside an async function, so a
session with no disk module never pays for it, and it is a real dependency of
`packages/coding-agent` (`jiti: "2.7.0"`, the repo pins exact versions) rather
than the transitive vitest copy the lockfile happened to carry. A new
`jiti-modules` component keeps it out of the flavors that cannot use it: `base`
and `full` enable it, `minimal` disables it, and the single-file build disables
it regardless of flavor (`resolveComponentSwitches({ singleFile: true })`)
because that artifact keeps everything external to stay zero-dependency.

Two build-side pieces make the cut real rather than cosmetic:

- `createComponentStubPlugin` swaps `jiti-loader.ts` for
  `jiti-loader-disabled.ts`, which reports `diskModulesIncluded() === false`.
  The loader is imported statically by `resource-loader.ts`, so a dead branch
  would have left it in the graph.
- `createLazyImportDropPlugin` resolves `import("jiti")` to an empty module
  when the component is off. esbuild cannot drop it on its own: the import sits
  inside a function that is still reachable from a live export.

**Aliases point at the running installation.** `@nanopi/pi-coding-agent` and the
sibling packages resolve to the `src/` trees in a source checkout, the `dist/`
trees in a built one, and to `import.meta.resolve` in an installed package.
A module file therefore sees the same classes, tools, and theme helpers the CLI
uses, which is what makes `registerTool` with a `typebox` schema work.

## Alternatives considered

- **Rename `.nanopi/extensions/` to `.nanopi/modules/`** (raised in the issue):
  rejected. `src/modules/` is the compiled-in layer; a second directory with the
  same name would give the codebase one word for two levels of the build. If a
  rename happens later, it should follow the loader, not precede it.
- **Rewrite the sample modules in JavaScript** (also raised in the issue):
  rejected. They import `ModuleApi`, `ToolDefinition`, `ModuleContext`, and
  `Theme` types; `.js` would delete the only compile-time check on their shape,
  and it would put them outside the root tsconfig's `packages/*/src` /
  `packages/*/test` coverage. Runtime cost of `.ts` is zero — jiti transforms it,
  and `import type` lines vanish.
- **Explicit paths only (`$NANOPI_EXTENSIONS` plus a settings array)**: the
  issue's option (a). Rejected in favour of (b): the user picked directory scan,
  and the agent and project directories already exist for skills and prompts, so
  "drop a file in `.nanopi/extensions/`" is one rule to remember instead of a
  settings key plus an environment variable.
- **`--extension` / `--no-extensions` flags**: the issue's option (c). Rejected:
  `$NANOPI_EXTENSIONS` covers the one legitimate case (point a build at a
  directory outside the two scan locations), and flags would have to be
  duplicated into every child process.
- **Bundle jiti into every build**: rejected. It is ~185 KiB of Babel-plus-esbuild
  transform machinery in a single file whose whole point is "unzip and run", and
  the single file cannot load a disk module anyway.
- **Keep the old `virtualModules`/`tsconfigPaths` resolution modes** from the
  pre-removal loader: rejected. They existed for the compiled-binary plugin
  system and for TypeScript source under ts-node; the three-tree alias covers
  the cases this loader has.

## Consequences

- `base`, `full`, and the npm bundle can be extended without a rebuild; `minimal`
  and the single-file artifact cannot, and the docs say so.
- `.nanopi/extensions/` changes meaning: it was documentation-only sample
  storage, and in a trusted project it is now loaded by default. The three
  sample modules in this repository are reachable through
  `$NANOPI_EXTENSIONS=.nanopi/extensions` instead of being loaded implicitly,
  because they are development helpers, not something a user should get by
  cloning the repo.
- A newer module that imports a package this build does not carry fails per
  file with a resolution error, which is visible in the startup diagnostics
  rather than silent.
- `jiti` joins the npm package's dependency list, so the bundle grows by its
  chunk; `pnpm-lock.yaml` gains the direct dependency edge only, since the
  package was already in the tree through vitest.
- The load set is fixed per session. Editing a disk module takes effect on the
  next process, same as a compiled-in module.
