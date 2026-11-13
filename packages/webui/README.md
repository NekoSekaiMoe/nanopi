# @nanopi/webui

Next.js (static export) rewrite of the nanopi browser UI.

Visual language is a clean-room reimplementation of Memoh's documented design
system: flat high-contrast surfaces, 1px borders, no atomic shadows, a single
purple accent, and a 768px mobile shell with an h-11 top bar and sheet
navigation. No Memoh code is copied (its repository is AGPL-3.0).

## Develop

```bash
pnpm install
pnpm --filter @nanopi/webui run dev
```

The dev server needs the nanopi webui API. The client calls it on the origin the
page was loaded from, so proxy the endpoint prefixes in [Backend
contract](#backend-contract) to a running `nanopi webui`, or serve the exported
`dist/` from that daemon and skip the proxy.

## Build

```bash
pnpm --filter @nanopi/webui run build
```

`next build` writes the static export to `out/`, then `scripts/export-dist.mjs`
copies it to `dist/`. `packages/coding-agent` copies `dist/` into its own
`dist/webui` and `nanopi webui` serves it.

Static export means no Next server: the app is a client-rendered SPA. Do not add
route handlers, server actions, middleware, or `next/image` optimization without
changing the delivery model.

## Backend contract

The app uses nanopi's existing endpoints and does not change the backend. Every
route below lives in `packages/coding-agent/src/modes/webui/webui-server.ts`.
All of them require the bearer token from the launch URL except `/health` and
the static assets, which the SPA needs before it can read `?token=`.

Sessions are addressed flat for listing and nested for everything that needs a
project: `/sessions` lists all of them with a `project_hash` on each row, and
`/projects/:hash/sessions` filters. Both forms read the same files on disk, so
a client may use either.

- Project and model state: `GET /project`, `GET /projects`, `GET /models`,
  `POST /models/reasoning-effort`, `GET /config`, `POST /config/reload`,
  `GET /skills`
- Sessions: `GET /sessions`, `POST /sessions`, `GET /sessions/search`,
  `GET /sessions/resolve/:short`
- One project's sessions: `GET /projects/:hash/sessions`,
  `GET /projects/:hash/sessions/:id`,
  `PATCH /projects/:hash/sessions/:id/rename` (active session only),
  `DELETE /projects/:hash/sessions/:id`
- Chat: `POST /chat` (SSE), `POST /chat/stop`, `POST /chat/stop-all`,
  `GET /chat/active` (`wait_s` turns it into a long poll),
  `POST /chat/permission`, `POST /chat/user-input`
- Run mode: `GET|POST /approval_mode`, `GET /mode/stream` (SSE)
- Workspace: `GET /fs/list`, `GET /fs/read`, `POST /fs/write`, `POST /fs/mkdir`,
  `POST /cd`, `GET /mcp/status`
- Provider accounts: `POST /provider-accounts`,
  `PATCH|DELETE /provider-accounts/:id`,
  `POST /provider-accounts/:id/models`,
  `PATCH|DELETE /provider-accounts/:id/models/:model`,
  `POST /providers/discover-models`
- OAuth login: `GET /extra/oauth/providers`, `POST /extra/oauth/login`,
  `GET /extra/oauth/status`, `POST /extra/oauth/prompt`,
  `POST /extra/oauth/cancel`, `POST /extra/oauth/logout`
- Extra module: `GET /extra/state`, `POST /extra/mode`,
  `GET|PUT /extra/settings`
- `GET /health`, `GET /` + static assets

The sidebar terminal is the one route outside that list: it upgrades to a
WebSocket at `/terminal`, speaks one JSON frame per message, and the token
arrives as a `?token=` query parameter or a `sec-websocket-protocol` entry
because a browser cannot set an `Authorization` header on an upgrade. It runs a
scratch shell in the session's working directory; nothing there reaches the
transcript.

`/live` is not part of this client and no longer exists on the backend: the
`?sync=1` transport has no caller here, so `/live`, `/live/mcp/trust`,
`/tunnel/status`, `/fs/search` and `/model-profiles` were deleted rather than
answered with stubs (#595). `GET /mcp/status` reads the `mcp-lite`
configuration (it does not connect anything), and reports `available: false`
when the build excludes that module; `POST /cd` moves the runtime's sessions to
another directory inside the workspace and answers with the directory it
actually opened.

Two routes answer without doing work, and both say so in the body rather than
by failing: `POST /command` reports that slash commands stay in the CLI, and
`POST /fs/open` reports that the host cannot focus an external editor so the
caller should use the inline viewer.

## Shape

This is one user's session in a browser, not a multi-agent IM. The distinction
is deliberate and worth stating, because the missing half reads as unfinished
work otherwise:

- One conversation on screen. The SPA shows one session at a time; the server
  does run turns on several sessions at once (the lock is per session, and
  `/chat` takes a `session_id` per request), and `/chat/active` lets a second tab
  see who holds a turn. What is missing is the group layer: no room, no
  membership, no `@`-routing, no budget split.
- One HTTP request per turn, answered as SSE, and plain JSON for everything
  else. The `?sync=1` WebSocket transport was removed with its last caller
  (#595); `/terminal` is a shell, not a second chat channel. A shared live view
  across tabs would mean reintroducing a hub, which is its own design.
- Chat plus a read-only file viewer and a scratch terminal. There is no editor
  workbench, and `plan-card` displays a plan the agent wrote through `todo`; it
  is not a task graph with dependencies.
- No personae. The model is picked per session; the agent's instructions come
  from `AGENTS.md` and the resource loader, not from declarative bot files.

Adding any of that changes the shape, so it needs a decision rather than a
patch. [Issue #704](https://cnb.cool/shinytale/nanopi/-/issues/704) holds the
comparison against pigo's `serve` that this section summarizes.

## Browser targets

Next.js 16 and Tailwind CSS 4 require Chrome 111+ / Safari 16.4+. The old
Preact webui's Chrome 99 target is not carried over.
