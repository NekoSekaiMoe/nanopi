# Changelog

## [Unreleased]

### Added

- Destructive git guard (issue #200): shell calls that would hit this checkout's index or working tree — `reset --hard`, a bare `reset`, `stash`, `clean -f`, `add -A`/`add .`, `checkout .`, `restore`, `commit --no-verify`, `push --force` — now go through the permission gate with a hazard line, even when the tool was already allowed for the session, and the refusal appended to the tool result tells the model what it tried to destroy. The analysis walks past quoting, `cd`, `bash -c`, `$(...)`/backticks and shell operators, and is checkout-aware: `git -C <other worktree> …` and `git worktree add` count as isolation, so a subagent's own tree is not gated. `/gitguard off` disables it. New exports: `analyzeShellCommand`, `analyzeGitInvocation`, `collectGitInvocations`, `listWorktrees`, `checkoutRoot`, `gitGuardNotice`

### Fixed

- The webui permission prompt is shown before a call can be paused for an explanation: `PermissionGate.check()` runs the prompt first and only pauses on an `"explain"` answer, so `PermissionBroker.explanationPrompter` has an active entry to park on. Previously the gate paused first, found nothing outstanding, and read the pause as a dismissal — every gated call in `nanopi webui` failed with "the permission prompt for this bash call was dismissed" and the browser never received a `permission_request` (issue [#293](https://cnb.cool/shinytale/nanopi/-/issues/293))
- A run mode switched outside the TUI now re-derives the session's tool set: the engine subscription applies the mode's tool filtering before drawing the badge, so a webui switch to `minimal` actually narrows the tools instead of leaving every tool active, and `extraBridge.setMode()` also applies it directly for a caller bound before any session started. A webui session also stops resetting the live mode to `defaultMode` on every new session (issue [#194](https://cnb.cool/shinytale/nanopi/-/issues/194))

## [20261022]

### Added

- The shell sandbox: `/sandbox on|off` registers a `BashOperations` backend that wraps `bash` commands in `bubblewrap` (Linux) or `sandbox-exec` (macOS) and activates it through the coding-agent's `registerBashOperations`/`setActiveBashOperations`. The working directory stays writable, everything else is read-only, `$HOME` inside the sandbox is `<agentDir>/sandbox`, and network is cut unless `--network` was passed (`--engine` and `--writable` configure the rest). Configuration lives in the extra settings (`sandbox: { engine, home, writable, allowNetwork }`), applies on session start so a reloaded file or `/sandbox` takes effect, and refuses to enable when no launcher is found instead of silently running unsandboxed. `detectSandbox`, `buildSandboxCommand`, `createSandboxedBashOperations`, `describeSandboxCall`, `normalizeSandboxConfig`, `resolveSandboxHome`, `shellQuote`, and `findExecutable` are exported. This is containment, not approval: the permission prompt still decides whether a command runs, and only `bash` is covered — not `edit`/`write`, `!` commands, or macOS relative-path writes
- Added the structured-input broker (`AskBroker`, `extraBridge.asks`): one outstanding questionnaire at a time, published to the webui server as a prompt event and answered by request id, with `cancelAll()` on session shutdown. It exists because `ask_user_question` renders through `ctx.ui.custom()`, which the headless webui session cannot provide, so the tool failed with "UI not available" there

### Changed

- Plan mode now allows `ask_user_question` in addition to `read` and the `ls`/`find`/`pwd` shell commands. Questionnaire answering is not a modification, and blocking it left plan mode unable to resolve the ambiguities it exists to find. The tool policy moved into the exported `planModeVerdict(toolName, input)` so the whitelist is testable on its own

### Fixed

- Mode badges (red `yolo`, green `plan`) were invisible in the default TUI: `ctx.ui.setFooter()` is a replacing setter and pi-ui installs its own footer later in every session start, silently dropping the extra's badge footer. Badges now flow through the `ctx.ui.setStatus()` channel under the `mode` key, with colors embedded by the producer via `theme.fg()`, and render right-aligned in whatever footer is installed.

### Removed

- Removed the `createBadgeFooter`/`renderFooterLine`/`renderBadges` exports (`src/footer.ts`); `src/badges.ts` exports `modeBadgeText` and `badgeLabels` instead, and the extension no longer calls `ctx.ui.setFooter()`.

## [20261013]

### Added

- Initial release of `@nanopi/pi-extra`, the run-mode, permission, and bridge module for nanopi: three run modes (`plan` read-only exploration with a shell-structure parser for `ls`/`find`/`pwd`, `minimal` shell-tools-only, `standard` unrestricted) enforced through `tool_call` interception, per-call permission prompts (allow once / allow this session / reject / let the AI decide with class-keyed cached verdicts), `--yolo` (skips prompts and the folder-trust confirmation), `/plan` and `/minimal` commands, footer badges (red `yolo`, green `plan`), extra-owned settings (`<agentDir>/extra/settings.json` with a project override: default mode plus lsp/mcp/subagent/askquestion/todo subsystem switches), ENV overrides (`NANOPI_INIT_MD` replaces the default system-prompt prefix; `NANOPI_API_URL`/`NANOPI_API_TOKEN`/`NANOPI_API_MODEL` register an appended OpenAI-compatible provider), the in-process `extraBridge` the webui server reads (mode state, permission prompts over SSE, settings, OAuth flow status), and one-time pairing codes (10-minute expiry, constant-time comparison, attempt limiting). Build flavors excluding the `modes` component alias the module to an inert stub: no flags, commands, badges, prompts, or bridge endpoints remain.
