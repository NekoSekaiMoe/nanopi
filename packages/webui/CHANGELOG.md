# Changelog

## [Unreleased]

### Added

- Initial port of the nanopi browser UI from AtomCode's webui (MIT, Copyright (c) 2026 Yubang Xu): Preact + Vite + Tailwind frontend served by `nanopi webui`, rebranded from AtomCode and wired into the pnpm workspace with pinned dependencies.
- Added a collapsible right info panel (session actions, working directory, skills) toggled from an always-present session header that shows the session title on history views and the brand wordmark on the landing page
- Added a user wallpaper: an image picked in the theme dialog sits behind the UI with an automatic scrim for readability and translucent blurred panels; stored only in this browser (localStorage, 4 MB cap)

### Changed

- Changed the landing greeting to a random classical Chinese poetry line (zh only; English keeps the fixed greeting) and the user-visible branding from `nanopi` to `NanoPi` (page title, manifest, offline page, sidebar and landing brand; command examples stay lowercase)
- Changed the theme to a warm monochrome palette (Arkloop-style: warm charcoal/paper neutrals, ivory/near-black accent pair instead of the clay-orange buttons) with a 14px base type scale and a MiSans-first font stack; the landing poem now shows its source on a second muted line and the pool grew from 12 to 28 lines
- Changed the webui session token to move from the page URL into `sessionStorage` on first load (the URL is rewritten immediately), and the server's bearer check is now constant-time

### Removed

- AtomCode-specific backend surfaces the nanopi server does not implement are stubbed or omitted: the `?sync=1` `/live` transport, per-tool-call permission gating (nanopi approval mode is always `bypass`), MCP status, model profiles, and slash commands. Provider accounts are now implemented against `models.json`
- Removed the input-footer sync toggle (it switched to the unimplemented `/live` transport and did nothing), the sidebar account login UI (avatar/sign-in button, sign-in status, logout entry; the `LoginButton` module and `signIn` lib with it), and the remote-access phone buttons plus its settings dialog

## [1.1.0] - 2026-10-07

- Initial import from AtomCode `webui/` at version 0.1.0.
