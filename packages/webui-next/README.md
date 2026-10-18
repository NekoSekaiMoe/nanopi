# @nanopi/webui-next

Next.js (static export) rewrite of the nanopi browser UI.

Visual language is a clean-room reimplementation of Memoh's documented design
system: flat high-contrast surfaces, 1px borders, no atomic shadows, a single
purple accent, and a 768px mobile shell with an h-11 top bar and sheet
navigation. No Memoh code is copied (its repository is AGPL-3.0).

## Develop

```bash
pnpm install
pnpm --filter @nanopi/webui-next run dev
```

The dev server needs the nanopi webui API. Proxy `/project`, `/models`,
`/sessions`, `/chat`, and `/fs/list` to a running `nanopi webui`, or serve the
exported `dist/` from it directly.

## Build

```bash
pnpm --filter @nanopi/webui-next run build
```

`next build` writes the static export to `out/`, then `scripts/export-dist.mjs`
copies it to `dist/`. `packages/coding-agent` copies `dist/` into its own
`dist/webui` and `nanopi webui` serves it.

Static export means no Next server: the app is a client-rendered SPA. Do not add
route handlers, server actions, middleware, or `next/image` optimization without
changing the delivery model.

## Backend contract

The app uses nanopi's existing endpoints and does not change the backend:

- `GET /project`, `GET /models`
- `GET /projects/:hash/sessions`, `GET /sessions/resolve/:short`
- `GET /projects/:hash/sessions/:id`
- `POST /chat` (SSE), `POST /chat/stop`
- `POST /chat/permission`, `POST /chat/user-input`
- `GET /fs/list`

`/live` is intentionally not used: the current daemon returns 501 for it.

## Browser targets

Next.js 16 and Tailwind CSS 4 require Chrome 111+ / Safari 16.4+. The old
Preact webui's Chrome 99 target is not carried over.
