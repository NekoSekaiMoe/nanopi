# Changelog

## [Unreleased]

### Added

- Initial port of the nanopi browser UI from AtomCode's webui (MIT, Copyright (c) 2026 Yubang Xu): Preact + Vite + Tailwind frontend served by `nanopi webui`, rebranded from AtomCode and wired into the pnpm workspace with pinned dependencies.

### Removed

- AtomCode-specific backend surfaces the nanopi server does not implement are stubbed or omitted: the `?sync=1` `/live` transport, per-tool-call permission gating (nanopi approval mode is always `bypass`), tunnels/PGY remote access, MCP status, provider-account and model-profile management, and slash commands.

## [1.1.0] - 2026-10-07

- Initial import from AtomCode `webui/` at version 0.1.0.
