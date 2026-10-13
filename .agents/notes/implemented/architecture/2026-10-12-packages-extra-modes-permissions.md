# Agent Note: packages/extra run-mode, permission, and bridge module

Status: implemented

## Problem

todo.md (2026-10-12) required run modes (`plan`/`minimal`/`standard`), per-call
permission prompts, subsystem toggles, ENV overrides, webui OAuth and CLI-to-webui
pairing — without putting any of that logic into the coding-agent core. A build
flavor must be able to exclude the whole module, in which case no trace may
remain: no `--yolo` flag, no `/plan`, no footer badges, no permission gating, no
webui mode selector. Additionally (user decision): MCP support returns as a slim,
vendored extension that subagents can use and the main agent cannot, and any
disabled component must not register tools or inject system-prompt text.

## Decision

The module is a new workspace package `packages/extra` (`@nanopi/pi-extra`,
lockstep version, `^x.y.z` dependency like every other internal package). The
coding-agent core touches it in exactly three places:

1. `src/extensions/index.ts` adds a hidden inline factory (loads pre-trust, so
   it can answer `project_trust` for `--yolo`). The factory registers
   `--yolo`, `/plan`, the `tool_call` interceptor, prompt injection, and the
   mode badges — pushed through the `ctx.ui.setStatus()` channel, not a custom
   footer (see
   [footer-badges-status-channel](../bug-fix/2026-10-13-footer-badges-status-channel.md)).
   Disabled subsystems and disabled flavors register
   nothing at all.
2. `src/modes/webui/webui-server.ts` imports the module's `extraBridge`
   singleton (same process as the extension) and mounts bridge endpoints:
   `/extra/state`, `/extra/mode`, `/extra/settings`, `/extra/pair` (unauthenticated
   pairing-code exchange), `/extra/oauth/*`, plus real `/approval_mode` values,
   SSE `permission_request` during `/chat` turns, and an answering
   `/chat/permission`. With the module absent every bridge endpoint 404s and
   the webui hides its selector and cards.
3. Build wiring: `buildconfig.json` component `modes`. The bundle and
   single-file scripts alias `@nanopi/pi-extra` to a generated inert stub when
   the component is disabled (same onResolve-shim technique as the OAuth flow
   shims, see
   [build-flavors](../process/2026-10-11-build-flavors-buildconfig.md)), so the code is physically absent from flavored builds. Source
   checkouts and the published `full` package always include it.

Mode semantics are layered, not overlapping: run mode = tool whitelist via
`tool_call` interception (`plan` allows only the `read` tool and `bash` commands
that parse as a single simple `ls`/`find`/`pwd` invocation; `minimal` restricts
the active tool set to the shell tools; `standard` restores everything).
Permissions are orthogonal per-call prompts (edit/write/shell when not `--yolo`)
with four answers: allow once, allow session (per tool), reject, or delegate to
a one-shot model judgment that then auto-decides the same tool+first-command
class for the rest of the session. Plan mode never prompts: the whitelist
already guarantees read-only.

MCP is `extras/mcp-lite`, a zero-dependency slimming of
irahardianto/pi-mcp-extension (stdio + streamable-http transports, initialize,
tools/list, tools/call; no OAuth, health pings, or reconnect machinery). Its
tools register with `defaultActive: false`, so the main agent never declares
them; subagent children get them via `-e <mcp-lite entry>` plus
`-t …,mcp__*` (pi-subagent-mini forwards both when the `mcp` subsystem toggle
is on). The extra's interceptor hard-blocks `mcp__*` in the main session and
injects a "subagents only" guideline, satisfying both the prompt and the
functional isolation requirements. The vendored-extra mechanics are the
established [bundled-extras](../feature/2026-10-11-bundled-extras.md) ones.

Subsystem toggles (`lsp`, `mcp`, `subagent`, `askquestion`, `todo`) live in the
extra's own settings file (`~/.nanopi/extra/settings.json` with a
`.nanopi/extra/settings.json` project override), not the core settings schema
(the old package-enable layer died with the plugin-system removal). A switch
applies through tool activation only: the webui settings page toggles live
(persist + `applySubsystem`, adding/removing the subsystem's tools from the
active set), and fresh sessions apply persisted `false` switches at
`session_start`. The `lsp` switch gates the vendored pi-lsp-mini extra (its
five `lsp_*` tools plus `/lsp`); language servers themselves spawn lazily on
first use per language.

## Alternatives considered

- **Vendored extra under `packages/coding-agent/extras/`** (the bundled-extras
  pattern): rejected by the todo's own decision table — the module is
  first-party functionality, versioned and published with the CLI, not a
  peripheral package. MCP is the exception that stays vendored because
  subagent children are separate processes that need an on-disk entry file to
  load (`-e`), which a compiled-in module cannot provide.
- **`enum`-style runtime gating only** (like the `webui` component) without the
  alias stub: leaves dead code in flavored bundles; the todo demands the module
  be absent from the package when the flavor excludes it. The alias shim
  achieves physical exclusion without dynamic imports at the registration site.
- **Core settings keys** for modes/toggles: would put mode semantics into the
  core settings schema; the todo allows "settings or extension-owned storage"
  and the extension-owned file keeps the core touchpoints minimal.
- **Reusing `ctx.ui.setStatus`** for footer badges: no color control; the
  todo explicitly requires red `yolo` / green `plan` badges. A custom footer
  reimplements the single usage line (same approach pi-ui takes).
  Superseded 2026-10-13: producers embed ANSI colors via `ctx.ui.theme.fg()`
  (the pi-rewind convention), so the status channel does carry the required
  colors — and the custom footer was silently replaced by pi-ui's
  `setFooter()` call on every session start. See
  [footer-badges-status-channel](../bug-fix/2026-10-13-footer-badges-status-channel.md).
- **`@nanopi/extra` with exact-pin dependency**: `scripts/check-pinned-deps.mjs`
  only exempts `@nanopi/pi-*` names and `scripts/sync-versions.js` rewrites
  internal deps to `^`, so an exact pin would fight the toolchain. Named
  `@nanopi/pi-extra` instead (user-approved).

## Consequences

- The webui gains a hard dependency on bridge response shapes
  (`/extra/*`, `permission_request` SSE, decision values
  `allow|allow_session|deny|ai_decide`); both sides ship together, and the
  404-on-stub contract is what degradation hinges on.
- Minimal mode's tool restriction is advisory at the declaration layer and
  enforced defensively at the interceptor (calls to non-shell tools are
  blocked even if something re-activates them).
- Plan-mode command analysis is a tokenizer, not a blacklisting substring
  match; it must track quoting so operators inside quotes are literal, and
  treat `find` predicates `-delete`/`-exec*`/`-ok*`/`-fprint*` as writes.
- `NANOPI_INIT_MD` replaces only the default prompt prefix (the
  `customPrompt` channel); AGENTS.md context injection and appended prompts
  still apply. `NANOPI_API_*` registers an additional OpenAI-compatible
  provider and never changes the default model.
- Permission prompts require someone to answer them. TUI/RPC sessions use the
  dialog primitives, webui sessions use the SSE bridge, and headless runs
  (`-p`/json) cannot ask: those keep today's allow-through behavior instead of
  denying every write, which would break non-interactive workflows.
- `@nanopi/pi-extra` declares no peer dependency on `@nanopi/pi-coding-agent`:
  pnpm turns peer cycles between workspace packages into `pnpm -r` task-cycle
  failures, and the package has no runtime need for it (the extension API is
  consumed through structural slices in `src/extension-api.ts`, checked at the
  registration site in the coding-agent).
- Pairing codes are 8-char one-time values with a 10-minute expiry,
  constant-time comparison, and attempt limiting; the webui startup URL no
  longer embeds the bearer token.
