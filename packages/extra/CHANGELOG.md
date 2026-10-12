# Changelog

## [Unreleased]

### Added

- Initial release of `@nanopi/pi-extra`, the run-mode, permission, and bridge module for nanopi: three run modes (`plan` read-only exploration with a shell-structure parser for `ls`/`find`/`pwd`, `minimal` shell-tools-only, `standard` unrestricted) enforced through `tool_call` interception, per-call permission prompts (allow once / allow this session / reject / let the AI decide with class-keyed cached verdicts), `--yolo` (skips prompts and the folder-trust confirmation), `/plan` and `/mode` commands, footer badges (red `yolo`, green `plan`), extra-owned settings (`<agentDir>/extra/settings.json` with a project override: default mode plus lsp/mcp/subagent/askquestion/todo subsystem switches), ENV overrides (`NANOPI_INIT_MD` replaces the default system-prompt prefix; `NANOPI_API_URL`/`NANOPI_API_TOKEN`/`NANOPI_API_MODEL` register an appended OpenAI-compatible provider), the in-process `extraBridge` the webui server reads (mode state, permission prompts over SSE, settings, OAuth flow status), and one-time pairing codes (10-minute expiry, constant-time comparison, attempt limiting). Build flavors excluding the `modes` component alias the module to an inert stub: no flags, commands, badges, prompts, or bridge endpoints remain.
