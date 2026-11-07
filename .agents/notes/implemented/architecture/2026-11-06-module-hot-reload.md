# Agent Note: Module hot reload and hot swap

Status: implemented

## Problem

`ca3c1ef3d` deleted the `/reload` command but left the reload state machine in
place: `_runtimeAvailability`, `reloadRequested`, `_requestReload()`,
`_flushRequestedReload()`, `_performReload()`, and `ModuleApi.requestReload()`.
Editing a disk module still needed a full restart, and three facts kept the
machinery from producing a different module set even when it ran:

1. `AgentSession._loadRuntime` created the `ModuleRegistry` once
   (`if (!this._moduleRegistry)`), so a reload could not replace the module list.
2. `ResourceLoader.reload()` guarded module loading with `if (!this.modulesLoaded)`,
   a one-shot boolean. The second reload never re-read a file.
3. No module had teardown: `on()` returned an unsubscribe nobody stored, and
   `registerTool` / `registerCommand` / `registerShortcut` / `registerFlag` /
   `registerMessageRenderer` / `registerSettingsItem` had no symmetric removal.
   Unloading a module would have left its handlers and tools in place.

The point was to replace "the user restarts the process" — not to reproduce
upstream pi's `/reload`, which rebuilds the whole `ExtensionRunner` and
invalidates every context handed out before it.

## Decision

Hot reload operates on **one file at a time**, driven by a ledger of what was
actually loaded. No directory rescan decides what changed.

### The ledger replaces the boolean

`DefaultResourceLoader.diskModules: Map<path, {key, name?, error?}>`, where
`key` is `ino:size:mtimeMs` from `diskModuleStatKey()`. The startup scan fills
it; every later reconcile compares the ledger against disk:

- recorded, file gone          -> unload
- recorded, stat key changed   -> unload, then run the factory again
- recorded, stat key unchanged -> nothing (a failed file included, so an
  unchanged broken module is reported once instead of on every event)
- not recorded, file present   -> load

This is the part worth copying from `deepseek-harness`'s `packages/boot/hmr`:
a stat record of loaded files answers "what changed" without conflating it with
"what exists on disk". A directory rescan cannot tell that a module's sibling
import belongs to it.

What is deliberately *not* copied: dsh's evict/rollback machinery, which needs
`--expose-internals` and Node's internal ESM loadCache to re-evaluate a module.
`jiti` with `moduleCache: false` already re-runs a file on every import, which
is why the "don't bundle" premise dsh pays for does not apply here.

### Teardown is a stack, not a hook

`createModuleApi()` records one undo closure per registration. `dispose()` runs
them LIFO, so a handler registered later that already closed over an earlier
one is dropped in a sane order. Each undo is identity-guarded
(`if (map.get(key) !== registered) return`), so a replacement registration that
took the same slot is never removed by the old module's teardown.

Stacks beat a `dispose`-only design because the registration API is the thing
that knows what a module installed. A module that forgets to clean up a tool
cannot leak it.

`SessionModule.dispose` exists for the rest: sockets, child processes, temp
dirs. Order is `session_shutdown{reason:"unload"}` (that module alone) → its
`dispose` hook → the registration stack. The event comes first because it is
where existing extras already clean up (`mcp-lite` clients, `pi-lsp-mini`
servers, `bash-bg` jobs, `pi-rewind` pending work), so they needed no edit.

### The registry keeps its identity

`ModuleRegistry.setModules()` / `loadModule()` / `unloadModule()` mutate the
module list on the registry object the session already bound. Rebuilding the
registry would hand a different object to every context, tool wrapper, and
command context created earlier. `_loadRuntime` therefore calls `setModules()`
on the existing registry instead of constructing a second one.

Both `loadModule` and `unloadModule` call `runtime.refreshTools()`, the hook a
module's own `registerTool()` uses. `AgentSession._refreshToolRegistry` already
reads `getAllRegisteredTools()`, so a tool appearing or disappearing reaches
the active set with no change at the call sites.

### Busy sessions queue

`AgentSession.reloadDiskModules()` returns `false` and sets `reloadRequested`
when the session is streaming, compacting, or inside an extension operation;
the existing flush path applies it at idle. One queue, one set of rules: the
hot watcher, `ctx.requestReload()`, and `onOperationComplete()` all land in the
same place.

## Trigger

`fs.watch(dir, {recursive: true})` over the three module directories, wrapped
in the existing `watchWithErrorHandler` + `FS_WATCH_RETRY_DELAY_MS` retry shape
the footer's git watcher uses. No chokidar: the repo pins exact dependency
versions and installs no scripts, and three directories do not justify a
dependency.

The watcher only signals `reloadDiskModules()`; it does not classify `add`
against `change` against `unlink`. Editors disagree about which event a save
produces, and a rename-over-temp save emits `rename` twice, so the ledger reads
disk state instead. (Upstream dsh watches only `'change'`, which is why a
deleted module never unloads there and an added one is not picked up.)

A directory that does not exist yet — `~/.nanopi/agent/extensions` on a fresh
install — is watched at its nearest existing ancestor *non-recursively* (a
recursive watch at an ancestor would descend the whole home directory), and the
watch is re-created at the real path once it appears.

Default off (`--hot` or `settings.modules.hotReload`). A watcher that rewrites
the session on every save is a debugging tool, not a default.

## Two bugs found on the way

- `diskModulesIncluded()` gated on `!isBundledNode`, which excludes the npm
  bundle for the wrong reason: there jiti is an external *dependency* and
  resolves fine. Replaced with a `createRequire().resolve("jiti")` probe, the
  same resolution the lazy `import("jiti")` uses.
- `jitiAliases()` derived the package root with `resolve(here, "..", "..")`,
  which only works while this file sits exactly two levels below its tree root.
  In the bundle (`dist/bundle/chunks/`) that points at `dist/`, so a disk module
  importing `@nanopi/pi-coding-agent` would load a second copy of the host and
  every `instanceof` across the boundary would fail. Replaced with
  `findHostTreeRoot()`, which walks up to the nearest directory holding both the
  package entry and `modules-api`.

## Alternatives considered

**Rebuild the `ModuleRegistry` per reload, like upstream pi's `_buildRuntime()`.**
Rejected: it invalidates every live context, which is why upstream has to tell
module authors that a `ctx` is dead after `await ctx.reload()`. Mutating the
list keeps command contexts, tool contexts, and event handlers valid.

**Watch with chokidar for correct `add`/`unlink` classification.** Rejected:
the ledger makes event classification unnecessary, and the dependency is real
weight in a repo that pins exact versions.

**Track the import graph so editing a helper reloads its importer.** Rejected
for now: each file gets its own `createJiti`, and reloading a helper would mean
maintaining a graph dsh needs only because its loader is per-process. The
documented workaround is to touch the module file. Revisit if it bites.

**Also hot-swap the host (registry, session, TUI, message codec table).**
Rejected as out of scope: ESM gives one instance per file, so re-importing the
host yields a second copy of every class and breaks `instanceof` across the
boundary. That needs either a new process or demoting cross-boundary objects to
`Symbol.for` weak protocols (as `theme.ts` already does) — a change to the
identity layer, not to module loading.

## Consequences

- `ResourceLoader` gained three members, all optional: `reloadDiskModules`,
  `watchDiskModules`, `stopWatchingDiskModules`. Optional keeps hand-written
  loaders (the SDK escape hatch, `examples/sdk/12-full-control.ts`, the test
  utilities) compiling; the session treats an absent implementation as "nothing
  to hot reload".
- `SessionShutdownEvent.reason` gained `"unload"`. Existing handlers need no
  change: they treat it like any other teardown. `mcp-lite`'s
  `if (event.reason === "reload") return` guard is unaffected, and on an unload
  it *does* close, which is what a re-run factory needs.
- `settings.schema.json` regenerated for `modules.hotReload`.
- A reload of a module whose factory throws leaves the module unloaded and
  records the error. There is no attempt to restore the previous version: the
  file on disk no longer describes it.

## Related

Partially supersedes
[remove the theme system and the /reload command](../simplification/2026-10-13-remove-theme-system-and-reload-command.md)
(its "module edits need a restart" consequence no longer holds for disk
modules) and
[remove the plugin system in favor of programmatic modules](../architecture/2026-10-13-remove-plugin-system-programmatic-modules.md)
(modules are no longer a load-once set). Builds on
[modules from disk with jiti](../feature/2026-10-21-modules-from-disk-with-jiti.md),
whose per-file loader made this cheap.
