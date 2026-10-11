# Agent Note: Remove the full screen TUI mode

Status: implemented

## Problem

nanopi shipped two interactive renderers: an inline main screen (terminal
scrollback owns the transcript) and a full screen alt-screen mode
(`tuiMode: "fullscreen"`, the default) with its own viewport layout, transcript
search, mouse selection, scrollbar, and five dedicated settings
(`fullscreenExitOutput`, `fullscreenScrollbar`, `fullscreenCopyOnSelect`,
`fullscreenWheelScrollLines`) plus `--tui-mode`. Every interactive-mode change
paid the dual-renderer tax (`switchTuiMode`, render-state capture/restore,
per-mode branches in copy, selection, status spacing), and the user asked for
the mode to go.

## Decision

- The interactive TUI always renders inline (`TuiMainScreen`).
  `createInteractiveTui` lost `tuiMode`/`fullscreen*` options;
  `switchTuiMode`, `mountInteractiveTui`'s layout-root branch, and the
  render-state capture/restore are deleted. `createInteractiveTuiReference`
  keeps the proxy (still needed while `renderer` is replaced on session
  switches).
- The fullscreen settings, their settings-manager getters/setters, their
  `/settings` entries, and `--tui-mode` are removed. `chat-viewport.ts` and
  its ScrollView dock layout are deleted; components mount directly on the
  main screen like regular mode did before.
- The fullscreen-only 3D easter egg (`easter-egg-3d*.ts`) is removed;
  `/arminsayshi` keeps the 2D component.
- The `scrollbarTrack`/`scrollbarThumb`/`searchMatchBg`/`searchMatchText`
  theme tokens (and their system-theme families/levels) are removed: nothing
  in coding-agent consumed them anymore.
- `TuiAltScreen` itself stays exported from `@nanopi/pi-tui` — it is library
  API, and the tui package keeps its own tests. Only the coding-agent wiring
  is gone.

## Alternatives considered

- Keep fullscreen as an opt-in (`tuiMode` default flipped to `regular`):
  rejected — the user asked for removal, and the dual-renderer branches were
  the maintenance cost being paid, not the default value.
- Keep the scrollbar/search theme tokens for future use: rejected — dead
  tokens in a published theme schema mislead theme authors; they can be
  reintroduced with a consumer.
- Remove `TuiAltScreen` from the tui package too: rejected — it is public
  library API consumed by nothing else in this repo but usable by external
  TUIs; removing it is a separate decision.

## Consequences

- Benefit: one renderer, one status-spacing rule, one copy path; settings
  surface shrinks by five entries and one CLI flag; ~700 lines of layout and
  switching code deleted.
- Cost: users who relied on the fixed viewport, transcript search
  (`ctrl+shift+f`), in-app selection copy, and the scrollbar lose them; the
  terminal scrollback becomes the transcript. `ctrl+shift+f` search and
  mouse selection are not replaced — the inline mode never had them.
- Migration: settings.json keys `tuiMode`, `fullscreenExitOutput`,
  `fullscreenScrollbar`, `fullscreenCopyOnSelect`, `fullscreenWheelScrollLines`
  are ignored (schema allows additional properties); themes containing the
  removed tokens keep validating (they were optional with fallbacks).
