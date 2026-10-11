# Changelog

## [Unreleased]

### Added

- Initial port of the nanopi browser UI from AtomCode's webui (MIT, Copyright (c) 2026 Yubang Xu): Preact + Vite + Tailwind frontend served by `nanopi webui`, rebranded from AtomCode and wired into the pnpm workspace with pinned dependencies.

### Changed

- Changed the landing greeting to a random classical Chinese poetry line (zh only; English keeps the fixed greeting) and the user-visible branding from `nanopi` to `NanoPi` (page title, manifest, offline page, sidebar and landing brand; command examples stay lowercase)

### Removed

- AtomCode-specific backend surfaces the nanopi server does not implement are stubbed or omitted: the `?sync=1` `/live` transport, per-tool-call permission gating (nanopi approval mode is always `bypass`), MCP status, model profiles, and slash commands. Provider accounts are now implemented against `models.json`
- Removed the input-footer sync toggle (it switched to the unimplemented `/live` transport and did nothing), the sidebar account login UI (avatar/sign-in button, sign-in status, logout entry; the `LoginButton` module and `signIn` lib with it), and the remote-access phone buttons plus its settings dialog

## [1.1.0] - 2026-10-07

- Initial import from AtomCode `webui/` at version 0.1.0.
