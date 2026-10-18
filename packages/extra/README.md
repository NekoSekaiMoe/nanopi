# @nanopi/pi-extra

Run modes, permission gating, subsystem toggles, ENV overrides, and the webui
bridge for [nanopi](https://github.com/NekoSekaiMoe/nanopi).

This package is a first-party module of the nanopi CLI, not a user-installable
extension: the coding-agent registers `extraInlineExtension` as a hidden
built-in and the webui server reads `extraBridge` in-process. The
The `module/extra` build component (buildconfig.json) controls inclusion;
flavors that disable it alias this module to an inert stub, leaving no flags,
commands, badges, prompts, or webui selector behind.

## Features

- **Run modes** — `plan` (read-only exploration: `read` tool plus `ls`, `find`,
  `pwd` as a single simple command), `minimal` (shell tools only), `standard`.
  Enforced by intercepting `tool_call`; the agent core is untouched.
- **Permissions** — per-call prompts for edit/write/shell when not `--yolo`:
  allow once, allow this session, reject, or let the model decide (class-keyed
  by tool + first shell command for the rest of the session).
- **Subsystem toggles** — lsp / mcp / subagent / askquestion / todo switches
  stored in `<agentDir>/extra/settings.json`, applied through the package
  enable layer (settings.packages filters) plus immediate tool filtering.
- **ENV overrides** — `NANOPI_INIT_MD` replaces the default system-prompt
  prefix; `NANOPI_API_URL`/`NANOPI_API_TOKEN`/`NANOPI_API_MODEL` register an
  additional OpenAI-compatible provider without touching the default model.
- **Webui bridge** — mode state, permission prompts over SSE, settings, and
  OAuth flow status.

## MCP isolation

MCP tools (`mcp__*`, from the `mcp-lite` bundled extra) are subagent-only: the
main agent blocks every `mcp__*` call and the system prompt says so, while
subagent children load `mcp-lite` directly and activate the tools with
`--tools mcp__*`.

## License

MIT
