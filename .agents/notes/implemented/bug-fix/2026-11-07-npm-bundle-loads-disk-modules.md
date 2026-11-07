# Agent Note: the npm bundle loads disk modules

Status: implemented

## Problem

`nanopi` installed from npm ignored every module file on disk. `docs/modules.md`
and `docs/configuration.md` promise that `$NANOPI_EXTENSIONS`,
`<agent dir>/extensions/`, and `.nanopi/extensions/` load in the `base` and
`full` builds, and the published package is `full`. Nothing loaded, nothing was
reported: the scan is gated by `diskModulesIncluded()`, and that returned false.

The gate had three terms:

```ts
isBuildComponentEnabled("jiti-modules") && !isBundledNode && !isSingleNodeFileRuntime()
```

`!isBundledNode` is the bug. `scripts/esbuild-shared.mjs` sets
`NANOPI_BUNDLED_NODE: "true"` in the defines of *both* bundle scripts, and the
npm package's `bin` is `dist/bundle/cli.js` — an esbuild bundle. So the one
artifact the docs describe was exactly the one taking the "no jiti" branch. The
term was there to keep disk modules out of the single-file artifact, which is
already `!isSingleNodeFileRuntime()`'s job.

Removing it alone was not enough; the bundle then failed at the first disk
import, for two more reasons found by running it:

1. `scripts/build-coding-agent-bundle.mjs` had its own hardcoded
   `external: ["@silvia-odwyer/photon-node"]` instead of
   `BUNDLE_EXTERNAL_PACKAGES`, so esbuild *bundled* jiti. jiti's own lazy path
   does `require("../dist/babel.cjs")`, which resolved next to the hashed chunk
   in `dist/bundle/chunks/` and threw MODULE_NOT_FOUND. Every `.ts` module failed
   with "Cannot find module '../dist/babel.cjs'".
2. `jitiAliases()` resolved `@nanopi/pi-coding-agent` to `dist/index.js` — the
   *unbundled* tree, which the npm package ships beside the bundle. A module
   got a second `CustomEditor`, a second `Text`, a second `Theme`, so class
   identity broke the `instanceof` checks the TUI runs. A third case: `typebox`
   had no alias at all, so a module's `Type.Object(...)` schema came from
   whatever `typebox` resolved beside the module file — usually nothing.

## Decision

**The bundled runtime resolves a module's bare imports to the namespaces it
already has.** `src/core/modules/virtual-modules.ts` holds the map and
`jiti-loader` passes it as jiti's `virtualModules` when `isBundledNode`, plus
`tryNative: false` so nothing falls through to a path-based import. Source
checkouts and unbundled installs keep the path aliases, where the host and the
module file import the same files and instance identity holds either way.

`virtual-modules.ts` imports the package root, which reaches back through
`resource-loader` -> `jiti-loader`, so `jiti-loader` imports it inside a
function. A static import would evaluate the map before the root barrel
finished and leave every entry `undefined`.

**jiti stays external in the bundle.** `commonBuildOptions()` now uses
`BUNDLE_EXTERNAL_PACKAGES`, which already listed `jiti`; the hardcoded array was
the drift. The package ships jiti as a dependency, so resolving it at runtime is
what the bundle's own `lazyJitiPlugin` was already written around.

**The single-file artifact is unchanged.** It keeps
`resolveComponentSwitches({ singleFile: true })`, so `jiti-modules` is off and
`jiti-loader-disabled.ts` answers. Its `nanopi.js` has no `node_modules` to
resolve jiti from.

`typebox`, `typebox/compile`, and `typebox/value` join the path aliases, because
a `ToolDefinition`'s schema has to come from the TypeBox instance the host
validates with.

## Alternatives considered

- **Drop `!isBundledNode` and stop there.** The gate is the reported bug, but
  the artifact still could not load a single module: the jiti external list and
  the alias targets were both wrong. The gate alone turns "silently none" into
  "an error per file", which is not a fix.
- **Point the aliases at `dist/bundle/index.js` instead of adding
  `virtualModules`.** The bundle's entry exports the same names, but a path alias
  makes jiti `import()` a second copy of an ESM module the process already
  evaluated: chunk hashes are shared, yet the entry module is instantiated
  again, so the classes differ.
- **Keep jiti bundled and rewrite its Babel require.** The require is jiti's
  own internal path, in code esbuild cannot see through. External is both
  smaller and the arrangement the package manifest already describes.
- **Treat a bundled build as an error case and change the docs instead.**
  Rejected: the npm package is the main install route, `full` is the flavor it
  ships, and the feature's whole point is a module without a rebuild.
- **Ship a `dist/` copy of only the narrow entry points to alias at.** The
  bundled and unbundled copies would still be distinct instances of the same
  classes, which is the failure being fixed.

## Consequences

- A nanopi from npm loads `$NANOPI_EXTENSIONS`, `<agent dir>/extensions/`, and
  (trusted) `.nanopi/extensions/`, as documented.
- The alias table and the virtual map now have a second consumer to keep in
  step: a new bare specifier a module may import has to be added to both, unless
  it is a package the module resolves itself.
- `dist/bundle/` grows by nothing (jiti was already shipped as a dependency) and
  shrinks by no longer containing a second copy of jiti plus Babel.
- `test/disk-modules-bundled-build.test.ts` pins the gate against the exact
  define combination the npm bundle injects (`NANOPI_BUNDLED_NODE: true`), the
  single-file combination, and a source checkout. Verified end to end by packing
  the package and loading a `.ts` module from `~/.nanopi/agent/extensions/`
  through `dist/bundle/cli.js --help`, which lists the module's flag.
- A bundled build still cannot load a module that imports a package the bundle
  does not carry (anything outside the virtual map and the host's dependencies).
  That failure is per file and reported as a diagnostic, same as before.
