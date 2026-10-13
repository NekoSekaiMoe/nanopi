# Agent Note: Remove the plugin system in favor of programmatic modules

Status: implemented

## Problem

The extension system (packages/coding-agent/src/core/extensions/, ~5100 lines) is a
full plugin runtime: jiti file loading, directory discovery
(~/.nanopi/agent/extensions, .nanopi/extensions), the settings `extensions` array,
`--extension`/`-e`/`--no-extensions` flags, `builtin:<name>` resolution, an npm/git
package manager (`nanopi install/remove/list`, package-manager.ts ~2400 lines),
bundled extras shipped as dist/extras directories, a 60-event ExtensionRunner woven
through AgentSession (66 emit sites), sdk.ts provider hooks via extensionRunnerRef,
per-mode ExtensionUIContext implementations, and a runtime reload/invalidation
pipeline.

User decision (2026-10-13): remove the plugin system entirely — including the
event-hook layer (ExtensionRunner/ExtensionAPI) — and let users extend manually
through a few exported core interfaces. The 10 bundled extras become compiled-in
built-ins with unchanged functionality; the exported interface set is
session + tools + hooks + custom provider/model registration.

## Decision

Replace the plugin runtime with one programmatic module interface. Everything
registerable stays registerable, but only at code time: built-in modules are
compiled in, users compose their own entry points against the package exports.
No file discovery, no package manager, no runtime reload.

### 1. New module API (src/core/modules/)

- `SessionModule = { name: string; factory: (nanopi: ModuleApi) => void | Promise<void> }`
  replaces `InlineExtension`. Factories run once per session construction, in
  order; errors throw (module conflicts are programming errors, not diagnostics).
- `ModuleApi` is the old `ExtensionAPI` surface restricted to what compiled-in
  consumers use (mapping below) minus everything loading-specific. Event names
  and method names are kept so the 14 migrating consumers (3 built-ins, pi-extra,
  10 extras) migrate mechanically.
- `ModuleRegistry` (new, ~400 lines) replaces ExtensionRunner: handler
  dispatch with per-event merge semantics (tool_call block/modify, message_end
  replacement, input transform, turn_end boundary merge), registered
  tools/commands/flags/shortcuts/renderers, provider registration queue,
  per-module context creation. No reload, no invalidation, no per-source
  metadata, no conflict reporting.
- `ToolDefinition` moves out of extensions/types.ts into src/core/tools/ (it is
  already the customTools contract). `ExtensionToolContext` becomes
  `ModuleToolContext`.
- `ExtensionUIContext` becomes `ModuleUIContext`; the interactive/rpc/print/webui
  implementations survive with renames.

### 2. Curated event set (24 events, one per real consumer)

Kept (consumers): project_trust (pi-extra), session_start (8), session_shutdown
(7), before_agent_start (5), agent_start (2), agent_end (2), agent_settled (2),
turn_start, turn_end (pi-rewind), message_start, message_update (2), message_end
(2), tool_call (3), tool_result (2), tool_execution_end (pi-rewind),
model_select (pi-fake-codex), input (pi-fake-codex), before_provider_request,
before_provider_headers (2), session_before_compact (2), session_compact (3),
session_before_fork, session_before_tree (pi-rewind), session_tree (todo-lite).

Cut (zero compiled-in consumers): resources_discover, session_info_changed,
session_before_switch, session_compact_failed, context, context_with_system,
cache_warming_decision, after_provider_response, provider_stream_event,
agent_before_settle, ui_prompt_start, ui_prompt_end, thinking_level_select,
user_bash. Corresponding emit sites in agent-session/sdk.ts are deleted outright.

Cut API methods (zero consumers): setSessionName, getSessionName, setLabel,
getSettings, getCommands, setModel, get/setThinkingLevel,
registerMessageRenderer, registerMarkdownTransformer, registerToolRenderer,
registerVirtualModel (+unregister*).

### 3. Consumer migration

- src/extensions/{builtin-commands,codex-compaction,llama} move to
  src/modules/ registering through ModuleApi.
- packages/extra keeps its structural-slice approach; ExtraExtensionAPI is
  re-sliced against ModuleApi (names unchanged where possible).
- extras/* (10 packages) are imported directly from src/modules/index.ts
  (compiled in). Their `@earendil-works/pi-coding-agent` imports are rewritten
  to relative deep imports (the root tsconfig paths, loader alias map, and
  bundle virtual modules for upstream names all die with the loader). Their
  factories keep working because ESM cycles only matter at module-eval time;
  value imports are consumed inside factory bodies.
- pi-subagent-mini: the spawn `extensions` param and `-e` forwarding are
  removed; mcp tools reach children via `-t mcp__*` only (mcp-lite is compiled
  into every binary, including child processes).

### 4. Deleted surface

- src/core/extensions/ (whole directory), package-manager.ts,
  package-manager-cli.ts, bundled-extras.ts, nanopi-manifest.ts, jiti dep.
- Settings: `extensions`, `extensionChangelogVersions`, `packages` (npm/git
  package sources) + the `nanopi config` panes that edit them. Skills,
  prompts, themes stay local-file based.
- CLI: `install`/`remove`/`list` subcommands, `--extension`/`-e`,
  `--no-extensions`, `builtin:<name>`.
- Build: `extra/<name>` flavor components and dist/extras shipping (all extras
  always compiled in; minimal builds grow slightly). The `modes` component and
  its inert stub stay. scripts/extras.mjs and the extras payload in
  copy-assets/single-file go.
- /reload keeps reloading settings/skills/prompts/themes; modules are static.
- examples/extensions/ (75 files), docs/extensions.md, docs/packages.md;
  docs/sdk.md gains the programmatic extension guide; extension tests are
  deleted or rewritten against ModuleApi.

### 5. Exported core interfaces (src/index.ts)

User addition (2026-10-13): every package's export surface must be as broad
as possible — the important core functions are all public, because
programmatic composition is now the only extension path; the exports are the
product. Concretely: `ModuleApi` keeps the useful method surface even where no
compiled-in consumer uses it (setModel, getSettings, setSessionName,
registerMessageRenderer, registerMarkdownTransformer, registerToolRenderer,
registerVirtualModel, ...); only the 14 zero-consumer *events* are cut.

`createAgentSession` (+ `modules`, `customTools` options), `AgentSession`,
`SessionModule`/`ModuleApi`/`ModuleContext`/`ModuleUIContext`, the 24 event
types, `ToolDefinition` + tool-definition factories, `ProviderConfig` +
provider registration, and the value exports extras already rely on
(SettingsManager, estimateTokens, TUI components, ...) plus the broader core
machinery (compaction, session manager, system prompt builder, exec, skills,
prompt templates, event bus). Sibling packages (pi-ai, pi-agent-core, pi-tui,
pi-extra) get the same export audit.

## Alternatives considered

- **Keep ExtensionRunner as an internal seam, delete only loading/installation**
  (smallest diff): rejected by user decision — the hook layer itself goes; the
  registry is rewritten slim with curated events only.
- **Redesign a fresh hooks paradigm (hooks object, interceptor types) instead of
  keeping the on()/register* shape**: rejected — it rewrites 14 consumers for
  zero capability gain; the old shape minus dead surface already is the minimal
  sufficient interface.
- **Keep per-extra build flavor components** via per-module alias stubs:
  rejected — 10 generated stubs for ~200 KiB savings; extras are always
  compiled in instead.
- **Keep the packages pipeline for skills/prompts/themes delivery**: rejected —
  it exists to distribute plugin payloads; local discovery covers the rest and
  the package manager is the main deletion target.

## Testing

- `pnpm run check` passes (biome, pinned deps, runtime deps, ts imports,
  entry graphs, tsc, browser smoke); zero references to extensions/, jiti,
  package-manager, `--extension`, or settings `extensions`/`packages` remain
  under src.
- The 10 extras + pi-extra + 3 built-ins compile in as BUILTIN_MODULES; the
  faux-provider suites (test-harness, dynamic-tools, runtime) pass.
- examples/sdk/06-modules.ts demonstrates user composition with exported
  interfaces only.
- CHANGELOG breaking-changes entry landed.

## Related

Partially supersedes (at implementation time):
[bundled extras as flavor-controlled default packages](../../implemented/feature/2026-10-11-bundled-extras.md),
[packages/extra run-mode, permission, and bridge module](../../implemented/architecture/2026-10-12-packages-extra-modes-permissions.md),
[built-in commands and codex compaction](../../implemented/feature/2026-10-11-builtin-commands-and-codex-compaction.md),
[build flavors via buildconfig.json](../../implemented/process/2026-10-11-build-flavors-buildconfig.md).

## Consequences

- ESM cycles between src/modules/index.ts and extras' deep imports: mitigated
  by importing concrete modules (tools, theme helpers) rather than the package
  root, and factories consuming imports only at setup/run time.
- The 24-event cut is consumer-driven; users who relied on cut events
  (message renderers, markdown transformers, widgets beyond setStatus) lose
  those hooks until re-added on demand.
- Test suite depends on extensionFactories/plugin loading in ~65 files; the
  migration must rewrite the harness-relevant ones (faux provider) first.

## Deviations from the proposal

- `nanopi config` (the resource-toggle TUI) was removed with the package
  manager: its panes are package/extension management. Settings are edited in
  settings.json directly.
- pi-rewind's `"escape escape"` shortcut registration was dropped (KeyId does
  not admit multi-key sequences; /rewind remains).
- ask-lite's optional i18n SDK import uses a non-literal dynamic-import
  specifier so the optional dependency stays optional under strict typecheck.
- The extras were never typechecked before (jiti loaded them at runtime); the
  compiled-in migration surfaced and fixed pre-existing type drift (mcp-lite
  tool results lacked `details`, pi-rewind null handling, parameter
  properties banned by erasableSyntaxOnly).
- Webui subsystem toggles no longer write settings.packages; they persist in
  the extra module's own settings and apply via tool activation only.
