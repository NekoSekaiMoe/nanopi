# Agent Note: a file or terminal pane owns its way back to the chat

Status: implemented

## Problem

On a phone, opening a file or the terminal from the drawer replaced the chat
full-screen with no way back except reopening the drawer and picking a session:
the pane had one exit, its own small X, and on a phone that X sat inside a
48px strip next to the path it repeated. Worse, the exit led nowhere useful in
two cases:

1. Tapping a session in the drawer while a pane was open loaded that session
   behind the pane: the tap looked ignored, and the chat only appeared after
   finding the pane's X.
2. The terminal had no close control on desktop at all. File view had one;
   terminal view was a dead end in the main column.

## Decision

A pane that replaces the chat carries the way back, in the place the platform
puts it.

- `MobileBar` takes an optional `back` (`{label, onBack}`). While a pane is
  open the leading slot becomes a back arrow to the chat and the drawer moves
  to the trailing slot, because switching files or sessions from inside a pane
  is still the point of the drawer.
- The bar's title names the pane (`终端`, or the file's basename) instead of the
  session, and every path/pane hint that the bar now shows is hidden under
  `md:`. That keeps the phone pane rows from printing the same string twice.
- `FileViewer`'s row disappears on a phone when it has no action left (clean
  file): an empty 48px strip above the content is worse than no strip. `Save`
  keeps the row alive when the draft is dirty.
- The terminal gets a close button with no `md:` guard: it is the desktop exit,
  and on a phone the bar's back arrow already covers the move. The composer
  keeps the bottom safe-area inset so the input is not under the home bar.
- `closePanes()` in `AppClient` closes both panes and is called by: the bar's
  back arrow, both pane close buttons, `onNew`, and `onSelectSession`.
- The notification body reads from the session title, not the bar title: a
  turn finishing while a pane is open still names the session.

## Alternatives considered

- Keep the drawer as the only exit and add a "back to chat" row inside it: the
  drawer is for switching, and the exit was never discoverable from there.
- Put a floating back button over the pane: it collides with the sticky
  `MobileBar`, which is already the phone's own back-position control.
- Make the pane a stacked route (URL state) so the browser back button works:
  correct eventually, but session and theme restore already live in query
  params, and this change only had to stop the dead end.
- Close the pane on every sidebar open: the drawer is exactly where the user
  goes to open the next file.

## Consequences

- One control per move: on a phone the bar's arrow exits, on desktop the pane
  header's X exits, and neither shows a duplicate of the other.
- `MobileBar`'s contract grew a prop; `TerminalPane` now requires `onClose`.
- Cost: the pane titles (`终端`) are only reachable through `t()`, so a new
  pane type must add its label to `lib/i18n.ts` as well.
- No automated coverage: the webui has no component tests, and the repo's
  browser smoke check only asserts build output. Verified by `next build`,
  `tsc --noEmit` and reading the three layout branches.
