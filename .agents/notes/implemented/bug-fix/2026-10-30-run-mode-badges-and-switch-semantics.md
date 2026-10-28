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
3. "Already in minimal mode" named no exit. There is no `/standard` in this
   module (leaving plan is the approval prompt, leaving minimal is the webui
   switch), so the notice left the user with a command that repeats itself and
   no stated way out.

## Decision

The switches describe state changes, and every mode a session can be in shows
on the footer.

- `badgeLabels()` pushes `engine.mode` whenever it is not `standard`, so
  `minimal` gets a badge next to `plan`. `standard` stays badge-less: it is
  what every session starts in, and a badge that is always on carries no
  information.
- Badge colors come from theme tokens proper to the meaning: `yolo` uses
  `accent` (a sticky-note "loosened rules" marker, not an error), `plan` keeps
  `success`, `minimal` uses `warning`. `BadgeThemeSlice.fg` is typed with those
  real token names instead of the previous `"error" | "success"` pair.
- A bare `/yolo` toggles; `/yolo on|off` still sets the value explicitly, and
  both complete after `/yolo ` through `registerCommand`'s
  `getArgumentCompletions` (a new optional field on the extension-API slice,
  already supported by the host and by pi-memory).
- `/minimal` while already minimal names the exit that exists
  (`/plan` to enter plan mode, or the webui settings switch) instead of
  restating the mode; `/minimal` from plan mode reports
  `Switched to minimal mode (left plan mode)`.

## Alternatives considered

- Keep `/yolo` as a query and add `/toggle-yolo`: two commands for one
  boolean, and the query form is the one users type by reflex.
- Report state *and* toggle on a bare invocation ("Yolo mode on (was off)"):
  the same keystroke would then mean "tell me" or "change it" depending on
  prior state, which is exactly the ambiguity that produced the report.
- Give `standard` a badge so the footer always shows one mode: three badges
  competing for the width of one footer line, two of which are the default.
- Add `/standard` so every mode has its own exit: `/minimal` is already the
  narrowest loadout, and the webui switch exists; a third command for one
  transition is more vocabulary than the problem needs.
- Color yolo `warning`/`error`: yolo is a deliberate choice the user makes,
  not a fault, and red next to a red `error` badge elsewhere in the footer
  reads as breakage.

## Consequences

- The footer now answers "which loadout am I in" for every mode; a session
  narrowed to the shell tools cannot be mistaken for a standard one.
- Cost: a mid-session theme switch leaves already-pushed badge colors stale
  until the next push (unchanged convention from
  [footer-badges-status-channel](2026-10-13-footer-badges-status-channel.md)).
- Cost: `accent` is a foreground token whose value differs per terminal
  theme, so yolo's badge color is the theme's accent, not a fixed color.
- Testing: `packages/extra/test/badges.test.ts` (labels for every mode,
  standard badge-less, per-label colors) and
  `packages/extra/test/webui-mode-wiring.test.ts` (bare `/yolo` toggles,
  `/minimal` twice names the exit, `/minimal` from plan mode reports the
  transition).
