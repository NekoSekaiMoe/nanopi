/**
 * pi-ui — RegisteredModule entry point
 *
 * Reskins Pi's interactive TUI to match a Codex-style look:
 *
 *   - an open gradient input frame with an embedded model/provider toolbar,
 *   - a one-line footer that preserves extension statuses and right-aligns
 *     context, token, and cost data,
 *   - an animated "Working (Ns · esc to interrupt)" shimmer,
 *   - flat Codex-style tool-call rows (`● Ran <cmd>` / `└ <output>`) for the
 *     built-in tools, and automatically for every other tool via a renderer
 *     lookup redirect on ToolExecutionComponent.
 *   - subagent-widget.ts -> the "• Exploring" group: read/ls/grep/find and
 *     subagent calls drop their own rows (see tools.ts) and render as one
 *     block over their actions
 *   - thinking.ts -> Codex-style thinking rows styled like tool rows
 *     (`• Thinking Ns` live tail, `• Thought for Ns` + model-written summary,
 *     ctrl+t to expand) and removal of the now-superseded "Hide thinking"
 *     settings entry
 *
 * Wiring only. Each concern lives in its own module and is installed against
 * documented ModuleApi / ModuleUIContext methods:
 *   - editor: none — the default composer stays; input frame and menu
 *     direction belong to the core TUI, not the reskin
 *   - footer.ts   -> ctx.ui.setFooter() status toolbar with right-aligned
 *     extension statuses (ctx.ui.setStatus channel) and shell-mode label
 *   - thinking.ts -> AssistantMessageComponent/InteractiveMode/SettingsList
 *     prototype patches (process-lifetime, like the tool renderer redirect)
 *   - working.ts  -> pi.on(agent_start/settled) + setWorkingIndicator/Message
 *     (also mirrors @zhushanwen/pi-todo steps into the Working line)
 *   - tools.ts    -> pi.registerTool() (overrides built-ins by name)
 *
 * The todo extension's own plan widget is suppressed here (suppressTodoWidget)
 * because the Working line already tracks the current step.
 *
 * pi.on handlers (tools, working) are registered ONCE at load so they don't
 * stack across session switches/reloads. The per-session setter (footer) is
 * rather than accumulate. Everything visual is guarded to ctx.mode === "tui";
 * other modes (rpc/print/json) keep Pi's defaults.
 *
 * Usage:
 *   pi -e ./src/index.ts
 *   pi install npm:@NekoSekaiMoe/pi-ui
 */

import type { ModuleApi, ModuleUIContext, Theme, ThemeColor } from "@nanopi/pi-coding-agent";
import { installFooter } from "./footer.ts";
import { FRAME_STOPS, gradientText } from "./gradient.ts";
import { installExternalToolRenderers, installShellRenderer, installToolRenderers } from "./tools.ts";
import { installExploringBlock, skinSubagentWidget } from "./subagent-widget.ts";
import { installThinkingDisplay } from "./thinking.ts";
import { captureTerminalWidth, installWorking } from "./working.ts";

const patchedThemes = new WeakSet<Theme>();
const PI_THEME_KEY = Symbol.for("@nanopi/pi-coding-agent:theme");

/**
 * The todo extension renders its plan as a widget above the editor
 * (`setWidget("todo", …)`). pi-ui hijacks that plan into the Working line, so
 * the duplicate panel is suppressed: every "todo" widget write is forced to
 * `undefined`. ctx.ui is shared across the whole session, so wrapping once is
 * enough even though refreshDisplay fires from many handlers.
 */
const todoWidgetsSuppressed = new WeakSet<object>();
function suppressTodoWidget(ui: ModuleUIContext): void {
  if (todoWidgetsSuppressed.has(ui)) return;
  type SetWidget = ModuleUIContext["setWidget"];
  const original = ui.setWidget.bind(ui) as SetWidget;
  const wrapped = ((key: string, content: unknown, options?: unknown) =>
    // The cast erases the call-overload so we can reroute "todo" writes.
    (original as (k: string, c: unknown, o?: unknown) => void)(
      key,
      key === "todo" ? undefined : content,
      options,
    )) as SetWidget;
  ui.setWidget = wrapped;
  todoWidgetsSuppressed.add(ui);
  // Clear anything the todo extension already registered before we wrapped it.
  ui.setWidget("todo", undefined);
}

function installResourceHeadingGradient(themeProxy: Theme): void {
  // Pi exposes a forwarding Proxy to extensions. Patch the shared instance
  // behind it so startup resources, which import the same global theme, see it.
  const globalThemes = globalThis as typeof globalThis & { [PI_THEME_KEY]?: Theme };
  const theme = globalThemes[PI_THEME_KEY] ?? themeProxy;
  if (patchedThemes.has(theme)) return;
  const originalFg = theme.fg.bind(theme);
  theme.fg = (color: ThemeColor, text: string): string => {
    if (color === "mdHeading" && /^\[[^\]\n]+\]$/.test(text)) {
      return gradientText(text, FRAME_STOPS);
    }
    return originalFg(color, text);
  };
  patchedThemes.add(theme);
}

export default function (pi: ModuleApi) {
  // Patch renderer lookup before any restored tool components are created.
  // This changes only presentation; extension-owned execute functions remain
  // registered and invoked as-is. The patch covers every tool pi-ui does not
  // re-register itself, so new extension tools get flat rows automatically.
  //
  // It is installed ONCE for the process lifetime and intentionally NOT
  // restored on session_shutdown: that event also fires on session switches
  // (/resume, /new, fork), and restoring there would silently revert
  // grep/find/web_search/etc. to Pi's bordered default for the rest of the
  // process, since nothing reinstalls the patch between sessions.
  installExternalToolRenderers();

  // Codex-style thinking rows in tool-row style ("• Thinking Ns" + latest
  // line while streaming, "• Thought for Ns" + the model's own one-sentence
  // summary afterwards), ctrl+t expansion, and removal of the "Hide thinking"
  // settings entry. Installed for the process lifetime for the same reason
  // as the renderer redirect above; the theme and the TUI render trigger are
  // refreshed per session_start below.
  installThinkingDisplay(pi);

  // The read/list/search group: rows land in the chat in finish order and the
  // live header under the editor closes when a turn stops exploring.
  installExploringBlock(pi);

  let restoreShellRenderer = () => {};

  // Register Codex-style tool renderers at load time. Most built-ins are
  // overridden by name; grep/find use the renderer-only prototype redirect so
  // extension-owned implementations remain intact regardless of load order.
  // Factory failures are isolated per tool. Renderers only run in TUI mode.
  try {
    installToolRenderers(pi, process.cwd());
  } catch {
    // Never let a rendering swap block extension load.
  }

  // Register the working-indicator lifecycle handlers once (pi.on has no
  // unregister — registering per session_start would stack duplicate timers).
  installWorking(pi);

  // (Re)apply the footer for each session. It is a replacing setter, not an
  // accumulating registration, so calling it per start is safe. The editor
  // stays the default composer: pi-ui deliberately ships no custom input
  // frame (see the pi-ui note in .agents/notes).
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    installResourceHeadingGradient(ctx.ui.theme);
    installThinkingDisplay(pi, ctx.ui.theme);
    suppressTodoWidget(ctx.ui);
    skinSubagentWidget(ctx.ui);
    restoreShellRenderer();
    restoreShellRenderer = installShellRenderer(ctx.ui.theme);
    installFooter(ctx);
    // The working row is one line inside the editor frame, so it needs the
    // width to fold its own label instead of wrapping onto a second line.
    captureTerminalWidth(process.stdout.columns || 0);
  });

  pi.on("session_shutdown", () => {
    restoreShellRenderer();
  });
}
