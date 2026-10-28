# Agent Note: Vendored extra tests run again, and syncing extras to upstream HEAD

Status: implemented

## Problem

The bundled extras note said upstream sync is "manual file replacement under
`extras/`", and the vendoring convention stripped upstream `devDependencies`
and `scripts` because the repo never ran the extras' own suites. Two
consequences:

1. Upstream fixes never landed automatically. A diff against upstream `HEAD`
   (pi-rewind `main` = v0.5.0, pi-simplify from `MattDevy/pi-extensions`)
   showed drift that the snapshot had not recorded, and nothing could run the
   upstream tests to notice.
2. The stored snapshot carried local edits that were not upstream work or
   import adaptation. `before_agent_start` already guarded
   `event.messageType === "user"` (nanopi's event is discriminated, unlike
   upstream's), so that part stays. The rest was dead narrowing added for
   `strictNullChecks`: it read `state.repoRoot`/`state.sessionId` into locals
   and returned early from `initSession` when `getRepoRoot` came back `null`,
   which skipped checkpoint rebuild and resume checkpoint creation entirely.

## Decision

Diff the vendored copies against a fresh clone of upstream `HEAD`, keep only
the adaptations the rebrand needs, and make the deltas re-checkable:

- pi-rewind keeps three deltas: `ExtensionAPI`/`ExtensionContext`/
  `ExtensionCommandContext` -> `ModuleApi`/`ModuleContext`/
  `ModuleCommandContext` imported from `../../../core/modules/types.ts`;
  `event.messageType === "user"` around `event.prompt`; and `state.repoRoot`
  instead of upstream's nonexistent `state.root` (upstream bug in
  `commands.ts`). The null-narrowing is hoisted so it does not change control
  flow: `repoRoot` is read into a local, checked, then assigned.
- pi-rewind's Esc+Esc shortcut came back, but not as `"escape escape"`: a
  module shortcut id is a single `KeyId`, and double-Esc already belongs to
  the host (`settings.doubleEscapeAction`). It is registered as `ctrl+shift+r`
  with the upstream files-only quick-rewind body.
- pi-simplify keeps only the `ModuleApi` renames, plus the upstream
  `git-diff.test.ts`, its own `vitest.config.ts` (the workspace config
  excludes `extras/**`), and exact-pinned `vitest`/`@types/node`
  `devDependencies` matching the rest of the repo, so `pnpm run test:scripts`
  and a plain `vitest --run` in that directory both work.
- `packages/coding-agent/tsconfig.build.json` excludes
  `src/extras/**/*.test.ts` and `src/extras/**/vitest.config.ts`, the same way
  it already excluded `extras/**/__tests__/**`. Without the exclusion,
  `check-runtime-deps` reports `vitest` as an undeclared runtime import of
  `@nanopi/pi-coding-agent` (an extra's test file is not part of any public
  package's runtime).

## Alternatives considered

- **Point the extras at the published npm packages and let upstream ship the
  fixes.** Rejected earlier for the plugin system removal, and the extras are
  compiled-in modules (`src/modules/index.ts`), not installable packages.
- **Add `vitest` to coding-agent `devDependencies` and let the vendored tests
  run in the workspace suite.** Rejected: `extras/**` is excluded from the
  workspace config on purpose (vendored snapshots are not first-party suites);
  a nested config keeps that boundary intact.
- **Keep upstream's inline `import("@mariozechner/pi-coding-agent")` type in
  `commands.ts`.** Rejected: repo rule forbids inline imports, and the alias
  map would need a `@mariozechner` entry the vendored file cannot rely on.

## Consequences

- Upstream sync is now a diff-then-reapply exercise with a short, documented
  adaptation list, and the extras' own tests are runnable.
- The extras still run under the repo's `biome` and `tsc` settings: untested
  upstream files keep their formatting, which is why the extras stay in
  `biome.json`'s ignore list.
- pi-rewind no longer answers to Esc+Esc inside nanopi; users get
  `ctrl+shift+r` or `/rewind`.
