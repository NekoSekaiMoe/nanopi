# Agent Note: Remove chord, evals, and telemetry packages

Status: implemented

## Problem

The nanopi fork removed the remote/durable/WebUI stack (`client`, `server`, `durable`, `protocol`, `env`, `codemode`, `mcp`) in earlier commits. Three workspace packages survived that purge without re-evaluation:

- `@nanopi/chord` (8.8k lines + tests): application-composition runtime (facets, services, replicated state, delta engine). Its README states it "is not a nanopi package" and can be used by unrelated applications. After the stack removal, zero files in the repo import it; only build order, tsconfig path mappings, the bundle script's external allowlist, and check scripts referenced it.
- `@nanopi/pi-evals` (1.5k lines): Docker-based eval harness driving the full AgentSession stack, reachable only through the root `eval` script. Dev tool, never published.
- `@nanopi/pi-telemetry` (0.9k lines): vendor-neutral telemetry contracts (`TelemetryContext`/`TelemetrySpan`, NOOP and in-memory impls). Its only consumer was a dead pass-through: `ProviderRequestOptions.telemetryContext` in pi-ai, set by nothing and read by nothing.

Concretely: the root build compiled chord first on every `pnpm run build`, `check-entry-graphs.mjs` walked it, and `check-pinned-deps.mjs` kept a special `internalPackageNames` set solely for it — all for code no runtime path could reach.

## Decision

All three packages are deleted from the workspace. Removal is complete, not stubbed:

- `git rm -r packages/chord packages/evals packages/telemetry`
- Root `package.json`: build/build:offline chains drop chord and telemetry steps; `eval` script removed.
- Root `tsconfig.json`, `packages/coding-agent/tsconfig.build.json`, `vitest.base.ts`, `packages/ai/vitest.config.ts`, `packages/agent/vitest.config.ts`: path mappings and aliases removed.
- `scripts/build-coding-agent-bundle.mjs`: `@nanopi/chord*` entries removed from `allowedExternalPackages` and the esbuild `external` list.
- `scripts/check-entry-graphs.mjs`: chord/telemetry removed from `WORKSPACE`.
- `scripts/check-pinned-deps.mjs`: `internalPackageNames` set removed; `isInternalWorkspaceDependency` now checks only the `@nanopi/pi-` prefix.
- `scripts/profile-coding-agent-node.mjs`, `packages/coding-agent/package.json` (`build:binary`): telemetry build steps removed.
- pi-ai: `@nanopi/pi-telemetry` dependency, the `telemetryContext` field on `ProviderRequestOptions`, its pass-through in `api/simple-options.ts`, and `test/telemetry-options.test.ts` (which only asserted that pass-through) are gone. This is a public API breaking change, recorded in the ai changelog.
- README package table rows removed; `pnpm-lock.yaml` refreshed (node_modules shrank by 31 packages).

`packages/coding-agent/npm-shrinkwrap.json` also pinned `@nanopi/pi-telemetry@0.84.2` from the registry; it was a stale 0.84.2-era artifact with no generator script and was deleted in the same change after explicit user confirmation.

## Alternatives considered

- **Keep chord as a standalone published library** (its README's stated intent). Rejected: the fork's direction is a lean monorepo; an unmaintained published runtime with zero in-repo consumers is pure liability. If needed later, chord can be resurrected from git history.
- **Keep telemetry contracts for future vendor-neutral tracing.** Rejected: the only integration point was an unread optional field; a future tracing effort can define its own contract when it has a real consumer.
- **Keep evals as a dev tool.** Rejected: it duplicated harness logic against the full agent stack and nothing in CI or checks invoked it; deleting the root `eval` script removes the entire surface.
- **Strip only the shrinkwrap's telemetry entries.** Rejected: the whole shrinkwrap was two majors stale; surgical edits to a dead lockfile had no value. The user later confirmed deleting the whole file.

## Consequences

- Workspace TS shrinks by ~11.2k source lines (chord 8.8k, evals 1.5k, telemetry 0.9k) plus their tests; build and check run over less code.
- pi-ai's public `ProviderRequestOptions` loses `telemetryContext` (breaking change); no in-repo caller breaks, verified by `tsc --noEmit` and the full non-e2e test suite.
- Third parties composing `@nanopi/chord` from this repo's registry history must fork or vendor it.
- Re-introducing any of these later means restoring from git history plus the config references listed above; the note's reference list is the checklist.

## Testing

`pnpm install` (lockfile refresh), `pnpm run check` (biome, pinned deps, runtime deps, ts-imports, entry graphs, tsc, browser smoke), `pnpm run build` (bundle 68 files, 8.5 MiB), and `./test.sh` from the repo root: 282 test files / 2464 tests passed, 50 skipped. All green.
