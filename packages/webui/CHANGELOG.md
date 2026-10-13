# Changelog

## [Unreleased]

## [20261013]

### Added

- Initial port of the nanopi browser UI from AtomCode's webui (MIT, Copyright (c) 2026 Yubang Xu): Preact + Vite + Tailwind frontend served by `nanopi webui`, rebranded from AtomCode and wired into the pnpm workspace with pinned dependencies.
- Added the run-mode selector: three modes (`standard` unrestricted, `plan` read-only exploration, `minimal` shell tools only) bridged onto the extra module, touch-friendly via a bottom sheet on small screens, and hidden entirely when the build excludes the module (`/extra/state` 404)
- Added real permission gating: the tool approval card offers Reject / Allow once / Allow this session / Let the AI decide, driven by `permission_request` SSE events during `/chat` turns and answered through `POST /chat/permission` (the stub always answered "no pending request")
- Added a pairing page replacing the token-in-URL handoff: enter the short one-time code `nanopi webui` prints to receive the session token
- Added the "Run modes & subsystems" settings dialog: default run mode for new sessions plus lsp/mcp/subagent/askquestion/todo switches (unavailable subsystems are marked)
- Added provider OAuth sign-in in the model settings: starts the CLI's web OAuth flow server-side, links the authorization page, and refreshes the config on completion; credentials land in the shared auth storage

### Changed

- Changed the approval-mode wire values to the extra module's run modes (`plan`/`minimal`/`standard`); the `/build` slash command became `/standard` and `/minimal` joined `/plan`
- Changed the model selector to follow the settings default model (the same source of truth the CLI uses); picks made in the webui persist as the shared default
- Added a collapsible right info panel (session actions, working directory, skills) toggled from an always-present session header that shows the session title on history views and the brand wordmark on the landing page
- Added a user wallpaper: an image picked in the theme dialog sits behind the UI with an automatic scrim for readability and translucent blurred panels; stored only in this browser (localStorage, 4 MB cap)

### Changed

- Changed the landing greeting to a random classical Chinese poetry line (zh only; English keeps the fixed greeting) and the user-visible branding from `nanopi` to `NanoPi` (page title, manifest, offline page, sidebar and landing brand; command examples stay lowercase)
- Changed the theme to a warm monochrome palette (Arkloop-style: warm charcoal/paper neutrals, ivory/near-black accent pair instead of the clay-orange buttons) with a 14px base type scale and a MiSans-first font stack; the landing poem now shows its source on a second muted line and the pool grew from 12 to 28 lines
- Changed the webui session token to move from the page URL into `sessionStorage` on first load (the URL is rewritten immediately), and the server's bearer check is now constant-time
- Changed the landing poem to a typewriter reveal: punctuation-aware pacing, a blinking serif caret, and the source line fading in on completion; `prefers-reduced-motion` shows it instantly
- Changed the composer to the Arkloop chat-input-box design: a 20px-radius box with a hairline border and a soft lifting focus shadow (no focus ring), single-row start with auto-growth to 300px, 16px absolute field type, click-anywhere-to-focus, and 34px rounded-lg monochrome send and outlined stop chips
- Changed tool calls to the Arkloop ExecutionCard style: an inline log row led by a colored status word (shimmering while running) with a hover color lift instead of a painted row, and a collapsible rounded panel (mono uppercase tool label, args/output sections) that animates open and closed via a 0fr→1fr grid transition; the trigger is keyboard-operable (Enter/Space)

### Removed

- AtomCode-specific backend surfaces the nanopi server does not implement are stubbed or omitted: the `?sync=1` `/live` transport, per-tool-call permission gating (nanopi approval mode is always `bypass`), MCP status, model profiles, and slash commands. Provider accounts are now implemented against `models.json`
- Removed the input-footer sync toggle (it switched to the unimplemented `/live` transport and did nothing), the sidebar account login UI (avatar/sign-in button, sign-in status, logout entry; the `LoginButton` module and `signIn` lib with it), and the remote-access phone buttons plus its settings dialog

## [1.1.0] - 2026-10-07

- Initial import from AtomCode `webui/` at version 0.1.0.
