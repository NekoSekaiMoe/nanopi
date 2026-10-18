> Legacy: the Next.js rewrite lives in `packages/webui-next` and is what
> `nanopi webui` serves. This package remains as a fallback until the rewrite
> reaches feature parity.

# @nanopi/webui

Browser UI for nanopi, served by `nanopi webui -p <port>` (default port 5335).
Preact + Vite + Tailwind. Ported from AtomCode's webui (MIT, see LICENSE).

## Develop the frontend

```bash
cd packages/webui
pnpm install
pnpm run dev          # vite dev server on http://localhost:5173
```

The backend served by `nanopi webui` answers the API calls; during development
point a second checkout at the vite dev server or use the mock server in
`scripts/mock-live-server.mjs`.

## Build for release

```bash
cd packages/webui
pnpm run build        # outputs dist/
```

`packages/coding-agent` copies `packages/webui/dist` into its own dist during
the monorepo build, and `nanopi webui` serves those assets.

## Port status

The default `/chat` transport is implemented against nanopi's AgentSession.
The `?sync=1` `/live` transport, permission gating (nanopi runs tools without
per-call approval, so the approval mode is always `bypass`), tunnels, MCP
status, and provider-account management are stubbed or omitted.
