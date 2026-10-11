# pi-extra-cmd

A bundle of small extra slash commands for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). It merges the standalone [`pi-exit`](../pi-exit/) and [`pi-init`](../pi-init/) packages and adds a new `/context` command.

## Commands

### `/exit`

Gracefully shuts pi down — a familiar alias for the built-in `/quit` (which cannot be shadowed). Uses `ctx.shutdown()`, the same path `/quit` takes, so the `session_shutdown` event fires and other extensions can flush state before exit.

### `/init [extra instructions]`

Generates a high-quality `AGENTS.md` contributor guide for the current repository. This is a command-driven replacement for the auto-invoked `init` skill: instead of relying on the model to discover a skill, `/init` injects the generation instructions as a user message, which always triggers a turn. Any arguments are appended as extra instructions, e.g. `/init also document the CI`.

### `/context`

Opens an interactive context-window inspector (dialog ported from
[pi-cc-extensions](https://github.com/minuque/pi-cc-extensions), restyled after the
[ask-lite](https://github.com/juicesharp/rpiv-mono) questionnaire TUI):

```
──────────────────────────────────────────────────────────
 Context Usage  45.2k / 200k tokens (22.6%)

 ███████████████████████████████                           

 › ■ System prompt     12.3k   6.2%
   ■ Memory             1.2k   0.6%
   ■ Skills                0    0.0%
   ■ Tools definition    9.8k   4.9%
   ■ Tool results        9.2k   4.6%
   ■ Context             8.1k   4.1%
   ■ Other               4.6k   2.3%
   ■ Free space        154.8k  77.4%

──────────────────────────────────────────────────────────
 Enter to preview · ↑/↓ to navigate · Esc to close
```

- `↑`/`↓` move the cursor, `Enter` opens a scrollable preview of the selected
  slice's actual content (system prompt, memory files, skills, tool definitions,
  tool results, conversation), `Esc` backs out one layer.
- The dialog is a bottom-docked full-width overlay with fixed chrome and hint
  footer; the preview middle region scrolls with `↑/↓ PgUp/PgDn Home/End` and
  shows `↑`/`↓` overflow markers (ask-lite conventions, pure keyboard).
- The headline number is reconciled from `ctx.getContextUsage()` (the footer's
  value) and a chars/4 estimate of what the next LLM call would carry; part rows
  are capped proportionally into the used total, with System prompt / Memory /
  Skills / Tools definition kept stable. `Other` absorbs the remainder.
- In non-TUI modes a plain `label: tokens` summary is emitted instead.


## Installation

```bash
pi install npm:@NekoSekaiMoe/pi-extra-cmd
```

Or load the source directly:

```bash
pi -e ./src/index.ts
```

## Notes

- `/context` part percentages are shares of the *context window* after capping
  into the reconciled used total; the headline percentage is measured usage vs.
  the context window.
- The estimate is conservative (chars/4 overestimates for most text); when the
  provider-reported usage is smaller than the estimate, the parts keep their
  proportions and the rows still add up to the used total.
- Tests: `npm test` (runs the data-layer and dialog tests through `jiti`).

## Credits

- `/context` data layer and behavior ported from
  [`minuque/pi-cc-extensions`](https://github.com/minuque/pi-cc-extensions) (MIT) —
  `extensions/feature/context.ts`.
- Dialog conventions (bottom-docked overlay, fixed hint footer, three-region
  scroll with `↑/↓` overflow markers) follow
  [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono)'s ask-lite
  questionnaire TUI.

## License

BSD-2-Clause
