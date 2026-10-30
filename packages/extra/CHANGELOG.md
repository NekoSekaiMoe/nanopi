# Changelog

## [Unreleased]

## [20261031]

### Added

- Destructive git guard (issue #200): shell calls that would hit this checkout's index or working tree — `reset --hard`, a bare `reset`, `stash`, `clean -f`, `add -A`/`add .`, `checkout .`, `restore`, `commit --no-verify`, `push --force` — now go through the permission gate with a hazard line, even when the tool was already allowed for the session, and the refusal appended to the tool result tells the model what it tried to destroy. The analysis walks past quoting, `cd`, `bash -c`, `$(...)`/backticks and shell operators, and is checkout-aware: `git -C <other worktree> …` and `git worktree add` count as isolation, so a subagent's own tree is not gated. `/gitguard off` disables it. New exports: `analyzeShellCommand`, `analyzeGitInvocation`, `collectGitInvocations`, `listWorktrees`, `checkoutRoot`, `gitGuardNotice`
- `--plan` and `--minimal` start a session in that run mode. They are the run-mode startup flags: the CLI's `--mode` was the output interface (now `--output`) and was consumed before a module flag could read it, so a module `--mode` never worked. `--plan` only sets the mode and does not open `/plan`'s "leave plan and run" confirmation (issue [#357](https://cnb.cool/shinytale/nanopi/-/issues/357))

### Changed
- The footer mode badges ask the theme for `modeYolo`/`modePlan`/`modeMinimal` instead of `error`/`success`/`warning`. The old tokens made each badge follow the terminal's palette, so `minimal` was only blue when the palette painted index 3 warm; the new ones are fixed red/green/blue in the system theme (issue [#364](https://cnb.cool/shinytale/nanopi/-/issues/364))

- A bare `/yolo` toggles the mode instead of printing its state: the switch is what a user types after reading the footer, and answering with "Yolo mode: off" made them retype the same command to flip it. Typing it again leaves the mode, so no separate exit command is needed. `/yolo on|off` still sets it explicitly, and both values now complete after `/yolo `
- `/minimal` typed while in minimal mode leaves it (`Left minimal mode`, tools restored): the mode's own command is both the way in and the way out, and there is no `/standard`. `/plan` keeps its exit prompt and still accepts a task argument, so a second `/plan` asks for a plan again. Entering one mode from another reports which mode was left (`Switched to minimal mode (left plan mode)`)
- Shell mode takes the whole footer slot: the yellow `shell` label replaces the mode badges instead of following them, and the badges come back when the composer leaves shell mode. Both were the same yellow, so `minimal shell` read as one word (issue [#364](https://cnb.cool/shinytale/nanopi/-/issues/364))

- `pi-fake-opencode` now shapes every wire protocol the Zen gate inspects (`openai-completions`, `openai-responses`, `anthropic-messages`, `google-generative-ai`) and replays the identity headers and body the official CLI sends, so free-tier models can call tools again; the lane follows the base URL the way opencode2api picks it (issue [#387](https://cnb.cool/shinytale/nanopi/-/issues/387), issue [#393](https://cnb.cool/shinytale/nanopi/-/issues/393))

### Fixed

- One run mode at a time on the footer, and one hue per mode: `yolo` red, `plan` green, `minimal` blue. `yolo` and a run mode still show together because they are orthogonal, but `plan` and `minimal` replace each other instead of adding a second label, and the yolo badge no longer borrows the theme accent (violet — the same hue a blue mode would want) (issue [#364](https://cnb.cool/shinytale/nanopi/-/issues/364))
- `minimal` gets a footer badge like `plan`: it was the one run mode a session could be in with no indication on the footer, while plan and yolo both showed
- `/minimal` and `--minimal` say so instead of narrowing to themselves in a shell-only build (`toolset: "bash"`, the minimal SKU): the tool set minimal narrows to is the one the build already has, so entering the mode changed nothing and leaving it restored a snapshot equal to the current loadout. `/plan` and the permission gate stay ([#354](https://cnb.cool/shinytale/nanopi/-/issues/354))
- The webui permission prompt is shown before a call can be paused for an explanation: `PermissionGate.check()` runs the prompt first and only pauses on an `"explain"` answer, so `PermissionBroker.explanationPrompter` has an active entry to park on. Previously the gate paused first, found nothing outstanding, and read the pause as a dismissal — every gated call in `nanopi webui` failed with "the permission prompt for this bash call was dismissed" and the browser never received a `permission_request` (issue [#293](https://cnb.cool/shinytale/nanopi/-/issues/293))
- A run mode switched outside the TUI now re-derives the session's tool set: the engine subscription applies the mode's tool filtering before drawing the badge, so a webui switch to `minimal` actually narrows the tools instead of leaving every tool active, and `extraBridge.setMode()` also applies it directly for a caller bound before any session started. A webui session also stops resetting the live mode to `defaultMode` on every new session (issue [#194](https://cnb.cool/shinytale/nanopi/-/issues/194))

- The git guard resolves the paths a command reaches and gates `checkout -f`, which a forced checkout of a tracked path slipped past, and it splits pipelines on the whole operator so `git status && git reset --hard` is analyzed as two invocations instead of one
- A permission-gated call in a session with no prompt (print, json, subagent children) settled as dismissed, so a child could not edit or write; the gate now carries `gated` instead of relying on a prompter that always answered "dismissed". Explain claims the call before pausing so the explanation turn has a target, and the gate no longer spins when no second prompter can settle the pause (issue [#376](https://cnb.cool/shinytale/nanopi/-/issues/376))
- The macOS seatbelt profile denies the network instead of saying `(allow default)` while `describeSandboxCall` reported "network blocked", and a configured sandbox whose launcher is missing notifies instead of falling back to a local shell silently (issue [#376](https://cnb.cool/shinytale/nanopi/-/issues/376))
- The webui `/fs/list`, `/fs/mkdir`, `/fs/read` and `/fs/write` endpoints resolve inside the workspace and answer 403 otherwise, and `extra` is in the API prefix list so a GET under it no longer falls through to the SPA shell (issue [#376](https://cnb.cool/shinytale/nanopi/-/issues/376))

### Removed

- `/mode`: run modes are reached by `/plan` and `/minimal` (and `/yolo`), so the dispatcher was a fourth spelling of the same switch
- `/standard`: `standard` is the tool set every session starts in, and it is reached by typing the command of the mode being left. The run mode value `standard` stays in the settings and the wire payloads

## [20261022]

### Added

- The shell sandbox: `/sandbox on|off` registers a `BashOperations` backend that wraps `bash` commands in `bubblewrap` (Linux) or `sandbox-exec` (macOS) and activates it through the coding-agent's `registerBashOperations`/`setActiveBashOperations`. The working directory stays writable, everything else is read-only, `$HOME` inside the sandbox is `<agentDir>/sandbox`, and network is cut unless `--network` was passed (`--engine` and `--writable` configure the rest). Configuration lives in the extra settings (`sandbox: { engine, home, writable, allowNetwork }`), applies on session start so a reloaded file or `/sandbox` takes effect, and refuses to enable when no launcher is found instead of silently running unsandboxed. `detectSandbox`, `buildSandboxCommand`, `createSandboxedBashOperations`, `describeSandboxCall`, `normalizeSandboxConfig`, `resolveSandboxHome`, `shellQuote`, and `findExecutable` are exported. This is containment, not approval: the permission prompt still decides whether a command runs, and only `bash` is covered — not `edit`/`write`, `!` commands, or macOS relative-path writes
- Added the structured-input broker (`AskBroker`, `extraBridge.asks`): one outstanding questionnaire at a time, published to the webui server as a prompt event and answered by request id, with `cancelAll()` on session shutdown. It exists because `ask_user_question` renders through `ctx.ui.custom()`, which the headless webui session cannot provide, so the tool failed with "UI not available" there

### Changed

- Plan mode now allows `ask_user_question` in addition to `read` and the `ls`/`find`/`pwd` shell commands. Questionnaire answering is not a modification, and blocking it left plan mode unable to resolve the ambiguities it exists to find. The tool policy moved into the exported `planModeVerdict(toolName, input)` so the whitelist is testable on its own

### Fixed

- Mode badges (red `yolo`, green `plan`) were invisible in the default TUI: `ctx.ui.setFooter()` is a replacing setter and pi-ui installs its own footer later in every session start, silently dropping the extra's badge footer. Badges now flow through the `ctx.ui.setStatus()` channel under the `mode` key, with colors embedded by the producer via `theme.fg()`, and render right-aligned in whatever footer is installed.


- Removed the `createBadgeFooter`/`renderFooterLine`/`renderBadges` exports (`src/footer.ts`); `src/badges.ts` exports `modeBadgeText` and `badgeLabels` instead, and the extension no longer calls `ctx.ui.setFooter()`.

## [20261013]

### Added

- Initial release of `@nanopi/pi-extra`, the run-mode, permission, and bridge module for nanopi: three run modes (`plan` read-only exploration with a shell-structure parser for `ls`/`find`/`pwd`, `minimal` shell-tools-only, `standard` unrestricted) enforced through `tool_call` interception, per-call permission prompts (allow once / allow this session / reject / let the AI decide with class-keyed cached verdicts), `--yolo` (skips prompts and the folder-trust confirmation), `/plan` and `/minimal` commands, footer badges (red `yolo`, green `plan`), extra-owned settings (`<agentDir>/extra/settings.json` with a project override: default mode plus lsp/mcp/subagent/askquestion/todo subsystem switches), ENV overrides (`NANOPI_INIT_MD` replaces the default system-prompt prefix; `NANOPI_API_URL`/`NANOPI_API_TOKEN`/`NANOPI_API_MODEL` register an appended OpenAI-compatible provider), the in-process `extraBridge` the webui server reads (mode state, permission prompts over SSE, settings, OAuth flow status), and one-time pairing codes (10-minute expiry, constant-time comparison, attempt limiting). Build flavors excluding the `modes` component alias the module to an inert stub: no flags, commands, badges, prompts, or bridge endpoints remain.
