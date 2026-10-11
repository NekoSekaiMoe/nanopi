# Agent Note: Codex-style welcome, single-line footer, and built-in /status

Status: implemented

## Problem

The interactive welcome (logo + long keybinding hints) and the multi-line
footer (cwd, token/cost明细, model, extension statuses) diverge from the
Codex reference the user wants, and there is no `/status` command: session
state (model, thinking, token usage, context) is only visible piecemeal via
`/session` and the footer. The pi-ui extra also still uses a gradient editor
frame and a metrics-rich footer.

## Decision

The default TUI and the pi-ui extra share one Codex-style layout:

- Welcome is a static dim box (`src/modes/interactive/components/welcome-box.ts`,
  `WelcomeHeader`): `π NanoPi vx.x.x` title, `model: <id>`,
  `provider: <p>  thinking: <level>`, `directory: <~>`, plus a
  `Tip: Use /status …` line truncated to the terminal width. The old
  logo/hints header and its easter-egg click target are gone; quiet-startup
  gating is unchanged.
- Footer is a single dim line everywhere:
  `used xk/yk · / for more details`, where used prefers
  `getContextUsage().tokens`, then percent-derived tokens, then session
  totals (`resolveFooterUsedTokens`). Extension statuses, cwd, cost, and model
  no longer render in the footer. `FooterComponent.setAutoCompactEnabled`
  stays as a no-op for call-site compatibility.
- `/status` is a built-in command (`src/extensions/builtin-commands/status.ts`,
  dialog in `status-dialog.ts`, registered in `builtin-commands/index.ts` and
  listed in `BUILTIN_SLASH_COMMANDS`): rows are Model / Model provider /
  Directory / Session / Thinking / Token usage / Context — nanopi mappings,
  no Codex-only Visit/Approval/Sandbox/Account/Limits rows — followed by the
  loaded-resource sections (`[Context]`/`[Skills]`/`[Prompts]`/`[Extensions]`,
  see [getLoadedResources](../architecture/2026-10-11-get-loaded-resources-api.md)).
  Chrome and exit match `/context` (bottom-docked overlay, accent rules,
  `↑/↓` scroll, `Esc` to close); non-TUI modes get plain-text notify.
- pi-ui matches: its open gradient editor frame (restored over the thin box — see
  [pi-ui-gradient-editor](./2026-10-11-pi-ui-gradient-editor-menu-above.md)) and the
  same single-line footer (extension statuses hidden). Its README is updated to match.

Related: [built-in /init, /context](./2026-10-11-builtin-commands-and-codex-compaction.md)
established the builtin-commands home this command extends.

## Alternatives considered

- Keep the old footer details and only reword the suffix: rejected — the user
  explicitly chose the single-line `used xk/yk` form with no token/cost明细,
  and keeping both would preserve the clutter the reskin removes.
- Copy the Codex `/status` rows verbatim (Approval/Sandbox/Account/Limits):
  rejected — nanopi has no equivalents; fake rows would mislead. The mapped
  rows (Thinking/Context instead) carry the same intent with real data.
- Reskin pi-ui only, leave the default TUI alone: rejected — the user chose
  core-default + pi-ui sync so the out-of-box experience matches.

## Consequences

- Benefit: welcome, footer, and `/status`/`/context` share one visual language;
  `/status` gives a single place for model/session/usage answers.
- Cost: footer no longer shows cwd/branch/cost/model/extension statuses;
  anyone relying on those must use `/status` (context/model) or the transcript.
  `FooterComponent` tests were rewritten for the single line; `welcome-box`
  and `collectStatusRows` have new coverage in `test/status-command.test.ts`.
- `BUILTIN_SLASH_COMMANDS` gains `status`; extensions using that name now
  conflict (builtin wins in autocomplete, same as other builtins). The
  built-in command itself is `source: "builtin"` and is excluded from the
  built-in-conflict startup diagnostics — listing it there was a false
  alarm, since `BUILTIN_SLASH_COMMANDS` names it on purpose.
