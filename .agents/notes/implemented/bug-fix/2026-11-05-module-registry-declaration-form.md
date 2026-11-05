# Agent Note: module registry reads the declaration, not the export keyword

Status: implemented

## Problem

`pnpm run build` (and `node scripts/copy-assets.mjs` chained into it) died before
reading a single module:

```
Error: .../modules/index.ts no longer exports BUILTIN_MODULES
    at readBuiltinModuleNames (scripts/module-registry.mjs:35)
```

Issue #517 (commit `e3887aed92`) narrowed the coding-agent root barrel's public
surface. Its rule is that the `export` keyword *at the declaration* decides what
`export *` publishes, so `BUILTIN_MODULES` in `src/modules/index.ts` went from
`export const BUILTIN_MODULES: SessionModule[] = [` to a bare
`const BUILTIN_MODULES...` plus a paired `export { BUILTIN_MODULES };` block at
the bottom of the file.

`scripts/module-registry.mjs` is a source parser, not an importer (it must not
pull the coding-agent graph into a flavored build). It located the table with
`source.indexOf("export const BUILTIN_MODULES")`. That literal no longer exists,
so `readBuiltinModuleNames` threw and every bundle/single-file build stopped at
`validateFlavorModules(repoRoot, readBuiltinModuleNames(repoRoot))`. Both
`build-coding-agent-bundle.mjs:58` and `build-coding-agent-single-file.mjs:90`
call it.

The paired block was never the problem: `export { ... }` still puts the name in
the module's export table (which is why #517's follow-up calls the earlier trick
useless for hiding). The parser was reading the wrong token — the `export`
keyword — when the table it wants is the `const` declaration regardless of how
the name is exported.

## Decision

`readBuiltinModuleNames` matches the array declaration with a regex that accepts
both spellings:

```js
const declaration = /(?:export )?const BUILTIN_MODULES\b[^=\n]*=\s*\[/.exec(source);
if (declaration === null) throw new Error(`${path} no longer declares the BUILTIN_MODULES array`);
const start = declaration.index;
const end = source.indexOf("\n];", start);
```

The entry loop (literal `{ name: "..." }` lines and `...helper()` spreads) is
unchanged, as are the `start`/`end` body slice and the spread-helper lookup. The
error now says "declares the BUILTIN_MODULES array" because the contract is the
array, not its export form; the build still fails loudly when the table is gone
or renamed, rather than silently shipping a stale module list.

Both old (`export const`) and new (bare `const` + paired block) fixtures parse to
the same name list, so the fix is not tied to the current source's spelling.

## Consequences

- Gain: the parser tracks the table itself, so a future surface-narrowing edit
  that only moves `export` around does not break the build again. The regex is
  anchored on `const ... = [` and still throws on a rename or a missing array.
- Gain: `validateFlavorModules` gets the same 18 names as before, so
  `buildconfig.json`'s `module/<name>` components and `moduleBundles` stay in
  sync without touching either config.
- Cost: the regex is slightly looser than the old `indexOf`; it would also match
  a `const BUILTIN_MODULES` that is not exported at all. That is acceptable —
  the parser's job is to read the registered modules, and a non-exported but
  present table is still the build's source of truth. A missing table is still a
  hard error.
- No change to `packages/coding-agent/src/modules/index.ts` or the root barrel:
  #517's narrowing stands. This is a build-script fix, not a revert.

## Alternatives considered

**Re-add `export` to the declaration in `modules/index.ts`.** Rejected: that
reverts #517's deliberate decision to keep `BUILTIN_MODULES` off the package
root. The root barrel uses `export *`, so the declaration's `export` keyword is
precisely the boundary; putting it back widens the public API to fix a private
parser. The build script is the side that encoded a wrong assumption.

**Import `enabledModules()` from the source instead of parsing.** Rejected: the
file-level comment already records why the build parses rather than imports —
importing pulls the whole coding-agent graph and `@nanopi/pi-extra` (which a
flavor may be excluding) into the build process. Parsing also keeps the build
independent of a compiled package.

**Match `export { BUILTIN_MODULES }` at the bottom and read upward.** Rejected:
it fixes only the current spelling and re-breaks if someone inlines the export
again, and it makes "where is the table" depend on a second, removable block.
The declaration is the one thing both forms share.

## Verification

- `scripts/module-registry.test.mjs`: two new tests pin the bare-`const` +
  paired-export form (issue #523) and the missing-declaration error; the three
  existing tests (`export const`, spread helper, helper with no literal name)
  still pass. 5/5 via `node --test scripts/module-registry.test.mjs`.
- On the real source, `readBuiltinModuleNames` returns the 18 names in
  `buildconfig.json`'s `moduleBundleNames` order, and
  `validateFlavorModules(repoRoot, readBuiltinModuleNames(repoRoot))` passes.
