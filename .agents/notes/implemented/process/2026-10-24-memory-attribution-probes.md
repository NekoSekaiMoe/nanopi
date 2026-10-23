# Agent Note: three memory probes, and what they changed about the budget

Status: implemented

## Problem

Issue #177 listed three things to measure before touching memory again, and
none of them had a reproducible number in the repository: the 48 MiB gap
between `full` and `minimal`, the growth of a long session, and what the
subagent child's module table is actually worth. Every previous figure lived in
an issue comment; a probe run by hand cannot be re-run by the next person, and
`pnpm run profile:tui` only reports one `startup rss` — a number that mixes the
model data of every provider in the flavor with the code every flavor shares.

The measurements also contradicted the assumption behind the first item. The
48 MiB was attributed to "46 provider catalog shards, `initializeModule`, the
permission hooks". Only one of those three turned out to cost memory.

## Decision

Three probes, each one file, each printing its own attribution:

- `pnpm run mem:attribution` (`scripts/mem-attribution.mjs`) builds each flavor,
  imports the single-file entry in a child process, reads `RssAnon` around the
  import, then repeats with every generated catalog table flattened to `{}`.
  The difference is the model data; the remainder is the code and module graph
  of that entry.
- `pnpm run mem:session` (`scripts/mem-session-probe.mjs`) feeds synthetic
  incompressible turns to the real `SessionManager` and prints retained
  `RssAnon` per turn count.
- `pnpm run mem:child` (`scripts/mem-child-probe.mjs`) spawns the real CLI the
  way `pi-subagent-mini` does, with the parent's module list, with every
  module, and with none, and samples the child's peak `RssAnon`.

All three read `RssAnon`, not `Rss`, for the reason the [rejected in-process
subagent note](../../rejected/simplification/2026-10-22-in-process-subagent-sessions.md)
already gives: `RssFile` is shared page cache and adding it across processes
double-counts.

## Measured

Linux x64, Node 24.22.1, median of 3 runs, single-file builds:

| flavor | entry | anon | model data | code + graph |
| --- | --- | --- | --- | --- |
| `minimal` | 2.4 MiB | 45 MiB | 0.4 MiB | 45 MiB |
| `base` | 5.2 MiB | 71 MiB | 2.1 MiB | 69 MiB |
| `full` | 9.3 MiB | 102 MiB | 20.5 MiB | 82 MiB |

Three consequences:

- **The catalogs are the `base → full` gap, not the `minimal → full` gap.**
  `base` ships 12 tables (2.1 MiB of data) and `full` ships 46 (20.5 MiB), so
  going from 12 to 46 catalogs costs ~18 MiB. Going from 0 to 12 costs 2 MiB.
  The 46 shards are 1.0 MiB of JSON; the ~18 MiB is what a compiled object
  literal graph of that size costs once the module executes.
- **Code and graph is not a constant.** `full` beats `minimal` by 37 MiB there
  with no model data at all. It tracks the entry's source text: the full entry
  is 9.3 MiB of JS, `minimal` is 2.4 MiB. Stubbing the interactive UI layer out
  of `full` dropped anon from 103 to 49 MiB, so the TUI is a large part of that
  half of the entry — the `minimal` SKU exists precisely to not carry it.
- **`CHILD_MODULE_SKIP` saves nothing measurable.** The child as spawned (12
  modules) measured 62.6 MiB anon; every module (16) measured 62.8 MiB; no
  modules measured 63.8 MiB. The 29 MiB/module figure in the earlier note came
  from a synthetic 1000-module process that has nothing to do with these modules,
  and this repository's 16 built-in modules register factories, they do not each
  load a module graph. The skip table still buys tokens: `pi-ui` and `pi-rewind`
  are inert in a `-p` child and `ask-lite`/`todo-lite` would advertise tools the
  child's default tool list does not enable. It does not buy memory.

Session growth is per message object plus its content, ~1 MiB of retained anon
per MiB of incompressible transcript; compaction that keeps the tail is the
only thing that drops either.

## Alternatives considered

- **Extend `profile:tui` instead of a second script.** `startup rss` there is
  the number the issue baselined against, but it needs a TTY and measures one
  build at a time. The attribution needs two imports of the same build, one of
  them rewritten, so it cannot be a flag on an interactive benchmark.
- **Measure the npm bundle (`dist/bundle`) rather than the single file.** The
  bundle splits into 63 chunks; flattening a catalog then needs the rewrite to
  follow the chunk that carries it, and the chunks hash differently per build.
  The single file is one text, one rewrite, and it is what ships.
- **Patch `buildconfig.json` to build a 12-catalog `full` and a 46-catalog
  `base`.** That measures two configs, not the attribution of one, and every
  combination would need its own build. Flattening the tables in the built
  artifact keeps every other byte identical.
- **Report `heapUsed` instead of `RssAnon`.** V8 reports a flat heap after a
  large object graph is executed and collected, while the pages stay resident;
  the issue's baselines are RSS-family numbers, so `RssAnon` is the comparable
  one.
- **Delete `CHILD_MODULE_SKIP` on the strength of the child numbers.** It is
  the one table that keeps a future module out of children automatically, and
  the token argument stands. It is cheap in code and free in memory, so it
  stays; the note records that it is not a memory lever.

## Consequences

- The three questions in #177 have numbers attached to repository scripts, so
  the next change can be measured against them instead of re-derived.
- `mem:attribution` restores the full catalog set before each flavor it builds:
  catalog generation is per flavor, and measuring `full` right after `minimal`
  reports zero catalog data. Skipping the hydrate makes the table silently wrong.
- The probes need `pnpm run build` first (`--skip-build` skips it) and Linux
  (`/proc/self/status`). They are diagnostics, not tests: nothing in `check`
  depends on them.
- The remaining `full` budget is now split in two: 20 MiB of model data (a
  `providerSets` decision, if users want fewer catalogs) and 82 MiB of entry
  code and graph (a build decision, already answered for `minimal`).
