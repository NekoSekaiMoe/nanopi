# Agent Note: Transcript rows a module does not own are contracts, not prototypes

Status: implemented

## Problem

pi-ui is the reference for how far a reskin can go without touching core code.
Half of it went through documented `ModuleApi` methods; the other half reached
into component prototypes:

- `AssistantMessageComponent.prototype.updateContent` (thinking rows)
- `InteractiveMode.prototype.toggleThinkingBlockVisibility` (ctrl+t)
- `SettingsList.prototype.render` (drop the "Hide thinking" row)
- `TuiMainScreen.prototype.render` (measure the live exploring block)
- `BashExecutionComponent.prototype.render` (`!` command rows)
- `ToolExecutionComponent.prototype.getCallRenderer/getResultRenderer/getRenderShell`
  (flat rows for tools pi-ui does not re-register)
- `Loader.prototype.updateDisplay` (retry/compaction status shimmer)

Each patch keyed an idempotency guard on a `Symbol.for(...)` and saved the
original method so a mismatched shape could fall back. That guard discipline is
the tell: the replacement was a real requirement with no contract.

The proposals in #453 rank these by cost. This note covers the first tier: "put
the remaining prototype patches behind exported interfaces". The tool-row
redirect is the load-bearing one. `registerToolRenderer` already existed, but it
answers "which definition draws this tool", so the only way to restyle a tool
pi-ui did not own was to re-register it — which replaces its `execute` too, and
pi-ui worked around that with `createBashToolDefinition(cwd)` and friends.

## Decision

Six registration methods cover every row a reskin needs, and each is additive:
the host asks the registry, the module never patches a class.

**`registerToolRowRenderer(resolver)`** — the row of one tool call.
`next()` is the row the remaining resolvers, then the tool's own definition,
would draw. A resolver returns `ToolRowRenderers` for that call only. The
render context (`ToolRowRenderContext`) adds `toolName` and `hide()`; `hide()`
sets a flag the component re-reads on its next `updateDisplay`, so a renderer
can fold a row into a surrounding group without unpicking the tree itself.
`ToolExecutionComponent` takes the resolved renderers as a constructor option,
so `execute`, schema, and prompt text stay with the module that registered the
tool.

**`registerShellRenderer(resolver)`** — `!` command rows.
`BashExecutionComponent` gained `setRowRenderer` and `getShellState()`; the
resolver receives the state, a factory for the default body, and the live
theme. The component keeps owning streaming output, expansion, and status — the
resolver only draws.

**`registerAssistantMessageRenderer(renderer)`** — an assistant message body.
`AssistantMessageComponent.updateContent` now asks the renderers first; the
first one returning `true` owns the body for that pass. The context exposes
`addChild`, `renderText`, `renderStopReason`, `transform`, `markdownTheme`,
`outputPad`, and `isStreaming`, so a renderer that only restyles thinking rows
delegates everything else instead of reimplementing it.

**`registerWorkingIndicator(renderer)`** — the streaming working line.
`WorkingStatusIndicator` gained `setRowRenderer`; it draws
`{ text, hidden? }` or returns undefined to keep the host row. `Loader` gained
`getMessage()` so a subclass that draws its own row can read the text
`setWorkingMessage` set.

**`registerSettingsItem(item)` / `unregisterSettingsItem(id)`** — settings rows.
A row is plain data (`label`, `description`, `currentValue`, `values`,
`onChange`); `SettingsSelectorComponent` draws it and reports the choice back
through `onChange`. `unregisterSettingsItem` also retires a built-in row: the
selector filters its own list by the registry's removed-id set, so a module that
supersedes a core setting does not patch `SettingsList.render`.

`getAssistantMessageRenderers`, `resolveToolRowRenderers`,
`hasShellRenderers`, `resolveShellRenderer`, `getSettingsItems`,
`getRemovedSettingsItemIds`, `applySettingsItemChange`, and
`getWorkingIndicatorRenderer` are the registry side.

## What stays patched, and why

- `theme.fg` for the `[Resource]` heading gradient. The theme is one shared
  instance, and the gradient is a color decision inside the palette, not a row.
  A palette contract is a different design (color → function) and is not part
  of this tier.
- `todo` widget suppression (`ctx.ui.setWidget`). Not a prototype patch: two
  modules disagreeing over a documented setter is a policy call, and pi-ui
  already implements it that way.
- `Loader.updateDisplay` for retry/compaction status text. Those are not the
  working row; they carry their own copy and would need a status-row contract
  of their own.

## Alternatives considered

- **Extend `registerToolRenderer` instead of adding a second resolver method.**
  Rejected: it answers a different question. `registerToolRenderer` returns a
  `ToolRenderers` (a definition's drawing functions) and callers use it to pick
  a whole tool; conflating "draw this call" with "draw this tool" would make the
  `next()` chain ambiguous and would still not carry `toolName` or `hide()`.
- **Have pi-ui keep re-registering tools with `createBashToolDefinition(cwd)`**:
  it works today, but it copies the tool's `execute` into the reskin and breaks
  when the core tool changes (a permission hook on a re-registered copy is a
  different tool). Rejected.
- **Expose the component classes and let modules subclass them.** Rejected:
  that is a wider contract than the rows need, and it makes every internal
  method a public API.
- **Let `registerSettingsItem` return a full `Component`.** Rejected: the row
  would re-implement input, search, and scrolling, and the selector would have
  to hand a component to module code. Plain data keeps the ownership split
  clean.
- **Make `registerWorkingIndicator` accumulate instead of replace.** Rejected:
  one line, one renderer; a chain of transformers over a single line has no
  consumer and makes "who wins" unclear.

## Consequences

- Benefit: pi-ui ships no prototype patches in its row layer. `tools.ts` lost
  `installExternalToolRenderers`'s class surgery, `thinking.ts` lost three
  patches, `working.ts` lost the Loader patch and the `setWorkingMessage` frame
  timer, and `subagent-widget.ts` lost the `TuiMainScreen` measure hook (the
  widget component records its own width and line count while painting).
- Benefit: `registerToolRowRenderer` reaches tools no module registered a
  definition for — the previous redirect could not, because it keyed on the
  component's private `toolName` field and had to fall back to
  `createBashToolDefinition` for tools it wanted to re-register.
- Cost: `AssistantMessageRenderContext` is a wide surface (eight members). A
  renderer may call `addChild` freely, so a malformed renderer can blank a
  message — mitigated by `renderWithModules` clearing the container when no
  renderer claims the message, and by the try/catch around each renderer.
- Cost: `registerAssistantMessageRenderer` runs on every message, including
  plain text ones. Each renderer must return `false` cheaply; pi-ui checks for
  thinking content first.
- Testing: `test/module-transcript-hooks.test.ts` covers resolver ordering,
  `next()` delegation, `hide()`, shell delegation, settings rows and removal,
  and working-indicator replacement. The existing pi-ui suites
  (`pi-ui-exploring-group`, `pi-ui-working-step`, `pi-ui-footer-status`) still
  pass unchanged.

## Related

Part of the #453 sequence: the `ModuleApi` split into composed contracts and the
runtime message codec registry are the other two tiers; this one is independent
of both.
Supersedes the "prototype patches are the only option" premise recorded in
[pi-ui gradient editor](../feature/2026-10-11-pi-ui-gradient-editor-menu-above.md).
