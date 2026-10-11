# Agent Note: Port AtomCode's webui and add `nanopi webui`

Status: implemented

## Problem

nanopi had no browser UI. AtomCode (MIT, https://atomgit.com/atomgit_atomcode/atomcode) ships a mature Preact + Vite + Tailwind webui (~23.5k lines incl. tests) driven by its Rust daemon over HTTP + SSE with a one-time Bearer token from the launch URL. Porting it means adopting that wire contract and reimplementing the backend against nanopi's `AgentSession` instead of the Rust kernel.

## Decision

Two-part split along ownership boundaries:

- `packages/webui` (`@nanopi/webui`, private, never published): the AtomCode frontend, rebranded atomcode→nanopi (strings, headers, `.nanopi` paths, PWA manifest), with exact-pinned deps per repo policy. Excluded from root `tsconfig.json` and biome (`packages/webui` is browser code with its own conventions: extensionless imports, JSX, 2-space style). Its 245 node:test tests run through the repo's `ts-import.mjs` preload because the local Node build lacks type stripping. LICENSE keeps AtomCode's MIT copyright; README documents port status.
- `packages/coding-agent/src/modes/webui/webui-server.ts`: a zero-dependency `node:http` server that serves `packages/webui/dist` (SPA fallback, source-checkout or installed-dist resolution) and implements the webui contract on `AgentSessionRuntime`:
  - Default `/chat` transport only: POST → `session.prompt()` with `AgentSessionEvent`→SSE mapping (`text_delta`→text, `thinking_delta`→reasoning, tool execution lifecycle, usage→done stats). One in-flight turn per server (`turnActive`), 409 otherwise; client disconnect aborts the turn.
  - `/models` exposes `getAvailableSnapshot() ∪ getAllAvailable() ∪ session.model` because `getAllAvailable()` alone returned empty without a warm availability pass. Models are identified by the composite key `provider/modelId` — ids may contain slashes, so the `/chat` model switch matches the whole catalog by key instead of splitting the string.
  - Sessions/projects/skills/fs endpoints map onto `SessionManager.list/listAll/parseSessionEntries`, `resourceLoader.getSkills()`, and `fs`. Session switch during `/chat` goes through `runtime.switchSession()`.
  - CLI: `nanopi webui [-p <port>]` subcommand (own arg parsing like `auth`), `AppMode` gains `"webui"`, extensions see mode `"print"` and prompt source `"webui"` (new `InputSource`).
- Deliberately stubbed (documented in code and webui README): `/live` sync transport (501 — the frontend only uses it with `?sync=1`), per-call permission gating (nanopi has no gate; `/approval_mode` always `bypass`, `permission_request` never fires), `/cd` (cwd-bound services cannot move yet), `/command`, MCP/tunnel/model-profile management (empty or 400 responses the frontend tolerates). Provider accounts are implemented against `models.json` and the sync/login/remote controls are removed from the UI — see
  [webui-provider-accounts](../feature/2026-10-11-webui-provider-accounts-models-json.md).

## Alternatives considered

- **Resurrect the deleted pi `server`/`client`/`protocol` stack.** Rejected: that stack spoke CBOR-over-stream chord envelopes for a remote WebUI, not a browser HTTP/SSE contract; resurrecting it also reinstates the chord dependency this fork just removed.
- **Implement the `/live` sync transport too.** Deferred: `/live` needs a persistent shared runtime with cross-tab fan-out (`live_hub` in atomcode). The default `/chat` transport covers single-tab use; `/live` returns a clear 501.
- **Add per-tool-call permission gating via agent-core's `beforeToolCall` hook.** Deferred: feasible (the hook exists in `AgentLoopConfig`) but a policy layer (build/plan/accept_edits/bypass) is its own project; MVP stays honest with `bypass`.
- **Put the server in `packages/webui`.** Rejected: it must import `AgentSession` internals from coding-agent, which would invert the dependency (webui → coding-agent) and leave the published CLI unable to serve the UI without a workspace link.

## Consequences

- `nanopi webui` gives a working browser chat (verified live: boot endpoints, session history, and a real SSE turn with reasoning/text deltas and turn stats) with default port 5335, `-p/--port` override, and token-gated loopback binding.
- The frontend keeps AtomCode features that show UI for stubbed backends (mode selector, attach menu, provider dialogs); those degrade to error notices until the corresponding endpoints are implemented.
- Branding replacement was string-level; favicon/PWA icons are still AtomCode artwork pending nanopi assets.
- `pnpm run build` now builds webui before coding-agent, and `copy-assets` copies `../webui/dist` into `dist/webui` (shipped in the published package via the existing `files: ["dist", ...]`).
- Renaming and deleting sessions only works for the active session (rename) or any listed file (delete); non-active rename is rejected with a clear message instead of rewriting session files behind the runtime's back.

## Testing

- `pnpm run check` green (biome, pinned deps, runtime deps, ts-imports, entry graphs, root tsc, browser smoke).
- `pnpm run build` green; `packages/webui` typecheck + 245 tests green.
- Live smoke on the built CLI: `/health`, static index, 401 on unauthenticated API, `/models`, `/project`, `/config`, `/skills`, `/sessions`, `/projects`, session detail with mapped messages, `/sessions/resolve/:id`, `/fs/list`, `/fs/mkdir`, `/approval_mode`, `/tunnel/status`, and one real `/chat` SSE turn streamed reasoning/text and `done` stats end-to-end.
- Full `./test.sh` suite run recorded separately in the session.
