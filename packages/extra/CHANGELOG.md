# Changelog

## [Unreleased]

### Fixed

- Mode badges (red `yolo`, green `plan`) were invisible in the default TUI: `ctx.ui.setFooter()` is a replacing setter and pi-ui installs its own footer later in every session start, silently dropping the extra's badge footer. Badges now flow through the `ctx.ui.setStatus()` channel under the `mode` key, with colors embedded by the producer via `theme.fg()`, and render right-aligned in whatever footer is installed.

### Changed

- Removed the `createBadgeFooter`/`renderFooterLine`/`renderBadges` exports (`src/footer.ts`); `src/badges.ts` exports `modeBadgeText` and `badgeLabels` instead, and the extension no longer calls `ctx.ui.setFooter()`.

## [20261013]

### Added

- Initial release of `@nanopi/pi-extra`, the run-mode, permission, and bridge module for nanopi: three run modes (`plan` read-only exploration with a shell-structure parser for `ls`/`find`/`pwd`, `minimal` shell-tools-only, `standard` unrestricted) enforced through `tool_call` interception, per-call permission prompts (allow once / allow this session / reject / let the AI decide with class-keyed cached verdicts), `--yolo` (skips prompts and the folder-trust confirmation), `/plan` and `/mode` commands, footer badges (red `yolo`, green `plan`), extra-owned settings (`<agentDir>/extra/settings.json` with a project override: default mode plus lsp/mcp/subagent/askquestion/todo subsystem switches), ENV overrides (`NANOPI_INIT_MD` replaces the default system-prompt prefix; `NANOPI_API_URL`/`NANOPI_API_TOKEN`/`NANOPI_API_MODEL` register an appended OpenAI-compatible provider), the in-process `extraBridge` the webui server reads (mode state, permission prompts over SSE, settings, OAuth flow status), and one-time pairing codes (10-minute expiry, constant-time comparison, attempt limiting). Build flavors excluding the `modes` component alias the module to an inert stub: no flags, commands, badges, prompts, or bridge endpoints remain.
