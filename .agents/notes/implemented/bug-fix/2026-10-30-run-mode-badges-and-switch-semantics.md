# Agent Note: Every run mode gets a footer badge, and the switches answer meaningfully

Status: implemented

## Problem

Issue #362 reported two defects in the mode switches, both visible in one
short session:

```
/yolo        -> Yolo mode: off        (the user wanted it on)
/minimal     -> Switched to minimal mode
/yolo        -> Yolo mode: off        (still off: the first line never set it)
/minimal     -> Already in minimal mode
```

1. A bare `/yolo` was a *query*, not a switch. The command split on an empty
   argument and answered with the current state, so flipping it took two
   invocations (or `/yolo on`). Users read the answer as the command having
   failed.
2. `minimal` produced no badge. `badgeLabels()` listed `yolo` and `plan` only,
   so a session that narrowed itself to the shell tools looked exactly like a
   standard session in the footer — the one mode whose effect is invisible
   until a tool call is refused. `plan` had `◆ 1 checkpoint plan`-style company
   on the footer; `minimal` and `yolo` had nothing but their own absence.
3. "Already in minimal mode" named no exit. There was no `/standard` in this
   module (leaving plan was the approval prompt, leaving minimal the webui
   switch), so the notice left the user with a command that repeats itself and
   no stated way out.

Issue #364 then reported what those answers produced in practice: `◆ 1
checkpoint yolo minimal` on one footer line. Two labels 14 columns wide for one
session, and the shell label the user asked about was a third yellow word — the
badge right behind it was the same yellow.

## Decision

The switches describe state changes, and every mode a session can be in shows
on the footer.

- `badgeLabels()` pushes `engine.mode` whenever it is not `standard`, so
  `minimal` gets a badge next to `plan`. `standard` stays badge-less: it is
  what every session starts in, and a badge that is always on carries no
  information.
- Badge colors are one hue per mode, chosen by the user who reported #364:
  `yolo` uses `error` (red), `plan` keeps `success` (green), `minimal` uses
  `warning` (blue — `warning` is a name, not a hue: the system theme maps it to
  the yellow family, and a theme file may point it anywhere). `BadgeThemeSlice`
  also exposes `bashMode`, the yellow every footer draws shell mode in.
- A bare `/yolo` toggles; `/yolo on|off` still sets the value explicitly, and
  both complete after `/yolo ` through `registerCommand`'s
  `getArgumentCompletions` (a new optional field on the extension-API slice,
  already supported by the host and by pi-memory).
- Every run mode has its own command — `/plan`, `/minimal`, `/standard` — so
  leaving plan or minimal is a slash command instead of only the webui switch.
  A mode command typed while already in that mode names `/standard` as the way
  out; entering one mode from another reports which mode was left
  (`Switched to minimal mode (left plan mode)`).
- The producer owns the whole footer slot: in shell mode (`!` at the composer)
  it pushes the yellow `shell` label *instead of* the badges, and the badges
  return when the composer leaves shell mode. The composer's text only reaches
  the extension at a mode change, a session start and a turn end (`agent_settled`),
  so those are the refresh points; pi-ui no longer appends a second `shell`
  label when the `mode` status already carries one.

## Alternatives considered

- Keep `/yolo` as a query and add `/toggle-yolo`: two commands for one
  boolean, and the query form is the one users type by reflex.
- Report state *and* toggle on a bare invocation ("Yolo mode on (was off)"):
  the same keystroke would then mean "tell me" or "change it" depending on
  prior state, which is exactly the ambiguity that produced the report.
- Give `standard` a badge so the footer always shows one mode: three badges
  competing for the width of one footer line, two of which are the default.
- Color yolo `accent`: accent *is* violet in the shipped themes, and violet is
  what "blue" mode would then be — two modes, one hue.
- Print `minimal` in the same yellow as the `shell` label (the guess behind
  #364's blue request): `yellow minimal` next to `yellow shell` is one word.
- Keep `shell` appended after the mode badges (the pi-ui default): whoever is
  in shell mode is not in a prompt, so the mode badge is the label that should
  step aside, and both were yellow.

## Consequences

- The footer now answers "which loadout am I in" for every mode; a session
  narrowed to the shell tools cannot be mistaken for a standard one.
- Cost: a mid-session theme switch leaves already-pushed badge colors stale
  until the next push (unchanged convention from
  [footer-badges-status-channel](2026-10-13-footer-badges-status-channel.md)).
- Cost: `warning` is a token name, not a color. The system theme draws it
  yellow, so minimal's blue is the reporter's terminal palette slot 3, not a
  fixed blue.
- Cost: the status line is now edge-triggered. A mid-typing exit from shell
  mode (backspace past the `!`) keeps the label until the next mode change,
  session start or turn end — the extension never sees the keystroke.
- Testing: `packages/extra/test/badges.test.ts` (labels for every mode,
  standard badge-less, one run mode at a time, shell mode taking the slot) and
  `packages/extra/test/webui-mode-wiring.test.ts` (bare `/yolo` toggles, a mode
  command names `/standard`, `/standard` leaves the mode and clears the badge).
  `packages/coding-agent/test/pi-ui-footer-status.test.ts` covers the footer no
  longer doubling the shell label.
