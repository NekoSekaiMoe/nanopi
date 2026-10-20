/**
 * What Codex's "Exploring" cell does, split across Pi's two render planes.
 *
 * Codex groups read/list/search work into one cell that appears in the
 * transcript where the work started and keeps growing until the model stops
 * exploring:
 *
 *   • Exploring
 *     └ Read AGENTS.md, BUILDING.md
 *       Search spawnJob in packages/coding-agent/src
 *
 * Pi draws finished calls into the chat and in-flight calls below the editor,
 * so the group needs both:
 *   - History: read/ls/grep/find/subagent calls keep no row and no body of
 *     their own (see tools.ts). This module appends one `Read …` line per
 *     finished call, so the chat holds the rows in the order the work
 *     happened; exploringHistoryRenderer keeps each row flat instead of the
 *     default `[pi-ui-exploring]` panel CustomMessageComponent would draw.
 *   - Live: the "• Exploring" header over the rows gathered so far, under the
 *     editor, where the next call is about to land. pi-subagent-mini writes its
 *     running jobs to the shared widget key and those become rows too, so a
 *     live subagent keeps the group open.
 *
 * When the turn stops exploring, the block leaves no trace: the live rows are
 * truncated (the chat keeps the rows), and once a later turn settles, history
 * shows only the "• Explored" row with nothing under it.
 */

import type {
	AgentToolResult,
	MessageRenderer,
	ModuleApi,
	ModuleUIContext,
	Theme,
	ThemeColor,
} from "@nanopi/pi-coding-agent";
import type { Component, TUI } from "@nanopi/pi-tui";
import { Text, TuiMainScreen, truncateToWidth } from "@nanopi/pi-tui";
import { type ExploreCall, exploreCallFor, exploringCalls } from "./tools.ts";

/** Widget key shared with pi-subagent-mini (src/index.ts: WIDGET_KEY). */
const SUBAGENT_WIDGET_KEY = "subagent-async";
/** Session message pi-subagent-mini appends for a subagent report. */
const SUBAGENT_COMPLETE_TYPE = "subagent-complete";
/** The history-row message this module appends per finished exploration call. */
export const EXPLORING_MESSAGE_TYPE = "pi-ui-exploring";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Braille spinner frames (U+2800–28FF) plus the static status marks used by
// pi-subagent-mini's `●` header or a job row's own glyph.
const ROW_GLYPH = /^([⠀-⣿●○◦✓✔✗✕■])(?:\s+|$)/u;
// "4 subagents running", "sa-5 · 28s · <scope>".
const RUNNING_HEADER = /^\d+\s+subagents?\s+running$/i;
const JOB_ROW = /^(sa-\d+)\s*·\s*(\d+)s\s*·\s*(.*)$/;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** The "• Exploring" header: the one row history and the live block share. */
export function exploringHeader(theme: Theme, active: boolean): string {
  const dot = theme.fg((active ? "accent" : "dim") as ThemeColor, "•");
  return `${dot} ${theme.bold(theme.fg("toolTitle", active ? "Exploring" : "Explored"))}`;
}

/** Consecutive Read targets share a row (`a, b, c`), as Codex does. */
function groupExploredCalls(calls: readonly ExploreCall[]): ExploreCall[] {
  const grouped: ExploreCall[] = [];
  for (const call of calls) {
    const previous = grouped[grouped.length - 1];
    if (previous && previous.action === "Read" && call.action === "Read") {
      previous.detail = `${previous.detail}, ${call.detail}`;
    } else {
      grouped.push({ ...call });
    }
  }
  return grouped;
}

/** One action row: the first hangs off the header, the rest line up under it. */
function actionRow(call: ExploreCall, first: boolean, theme: Theme, width: number): string {
  const branch = theme.fg("dim", first ? "  └ " : "    ");
  const body = `${theme.fg("accent", call.action)}${call.detail ? ` ${theme.fg("toolOutput", call.detail)}` : ""}`;
  return truncateToWidth(`${branch}${body}`, Math.max(1, width), "…");
}

/** The live block: header plus the actions gathered so far. */
export function exploringRows(calls: readonly ExploreCall[], theme: Theme, width: number): string[] {
  if (calls.length === 0) return [];
  const rows = [truncateToWidth(exploringHeader(theme, true), Math.max(1, width), "…")];
  for (const [index, call] of groupExploredCalls(calls).entries()) {
    rows.push(actionRow(call, index === 0, theme, width));
  }
  return rows;
}

/** A chat row that lines up with the action rows a live block showed above it. */
function historyRow(call: ExploreCall, theme: Theme, width: number): string {
  return actionRow(call, false, theme, width);
}

/**
 * Chat renderer for those rows: the flat action row itself, at the
 * transcript's outputPad. Without it every row falls back to
 * CustomMessageComponent's default panel — a `[pi-ui-exploring]` label in a
 * tinted box — which breaks the row shape every other tool call uses.
 */
export const exploringHistoryRenderer: MessageRenderer = (message, options) => {
  const content = typeof message.content === "string"
    ? message.content
    : message.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
  return new Text(content, options.outputPad, 0);
};

/** Job lines pi-subagent-mini writes: one row per running job. */
function subagentCalls(lines: readonly string[], theme: Theme): ExploreCall[] {
  const calls: ExploreCall[] = [];
  for (const raw of lines) {
    // pi-tui's Text pads every row to full width and adds a 1-cell margin.
    const plain = stripAnsi(raw).trimEnd().replace(/^ /, "").trim();
    if (!plain) continue;
    const body = plain.replace(ROW_GLYPH, "").trim();
    if (RUNNING_HEADER.test(body)) continue;
    const job = JOB_ROW.exec(body.startsWith("└") ? body.slice(1).trim() : body);
    calls.push(
      job
        ? { action: "Search", detail: `${job[3]!.trim()} ${theme.fg("dim", `· ${job[1]} ${job[2]}s`)}` }
        : { action: "Search", detail: body },
    );
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Live block under the editor
// ---------------------------------------------------------------------------

type WidgetComponent = Component & { dispose?(): void };

/** Per-TUI live block: the actions gathered for the current turn. */
interface LiveBlock {
  calls: ExploreCall[];
  collapsed: boolean;
}

const liveBlocks = new WeakMap<object, LiveBlock>();
/** Every TUI that has rendered the block, so a settle can reach all of them. */
const knownTuis = new Set<object>();
/** Lines each TUI last painted for the block; the truncation length on settle. */
const renderedBlocks = new WeakMap<object, { lines: number }>();

function liveBlockFor(tui: object): LiveBlock {
  let block = liveBlocks.get(tui);
  if (!block) {
    block = { calls: [], collapsed: false };
    liveBlocks.set(tui, block);
    knownTuis.add(tui);
  }
  return block;
}

function liveComponent(tui: TUI, theme: Theme): WidgetComponent {
  return {
    invalidate(): void {},
    render(width: number): string[] {
      const block = liveBlocks.get(tui);
      if (!block || block.collapsed) return [];
      return exploringRows(block.calls, theme, width);
    },
  };
}

/**
 * Take the live block off the screen. The live region is the block plus the
 * widget container's leading spacer, so the rewind length is the one measured
 * while painting, not a guess added onto a counter this module cannot see.
 */
export function collapseExploringBlock(): void {
  for (const tui of knownTuis) {
    liveBlockFor(tui).collapsed = true;
    const rendered = renderedBlocks.get(tui);
    if (!rendered || rendered.lines <= 0) continue;
    try {
      (tui as { terminal?: { write?: (data: string) => void } }).terminal?.write?.(`\x1b[${rendered.lines}A`);
      (tui as { requestRender?: () => void }).requestRender?.();
      rendered.lines = 0;
    } catch {
      // The next full repaint drops the block anyway.
    }
  }
}

/** Size the live block is rendered at; the rows are pre-coloured, so ask the TUI. */
const blockWidths = new WeakMap<object, number>();

function columnWidth(): number {
  for (const tui of knownTuis) {
    const width = blockWidths.get(tui);
    if (width) return width;
  }
  return Math.max(1, (process.stdout.columns || 80) - 1);
}

const TUI_RENDER_ORIGINAL = Symbol.for("@NekoSekaiMoe/pi-ui:exploring-tui-render");
const skinnedContexts = new WeakSet<object>();

function installRenderMeasure(): void {
  try {
    const prototype = TuiMainScreen.prototype as unknown as Record<string | symbol, unknown>;
    const original = prototype.render as ((this: object, width: number) => string[]) | undefined;
    if (typeof original !== "function" || prototype[TUI_RENDER_ORIGINAL]) return;
    prototype[TUI_RENDER_ORIGINAL] = original;
    prototype.render = function (this: object, width: number): string[] {
      const lines = original.call(this, width);
      const block = liveBlocks.get(this);
      if (!block) return lines;
      blockWidths.set(this, Math.max(1, width - 1));
      renderedBlocks.set(this, { lines: block.collapsed ? 0 : block.calls.length > 0 ? block.calls.length + 1 : 0 });
      return lines;
    };
  } catch {
    // Without the measurement a stale block is cleared by the next full repaint.
  }
}

/**
 * Wrap ctx.ui.setWidget: pi-subagent-mini's running jobs become rows of the
 * live block, and their disappearance settles it.
 */
export function skinSubagentWidget(ui: ModuleUIContext): void {
  if (skinnedContexts.has(ui)) return;
  type SetWidget = ModuleUIContext["setWidget"];
  const original = ui.setWidget.bind(ui) as SetWidget;
  const call = original as (key: string, content: unknown, options?: unknown) => void;
  const wrapped = ((key: string, content: unknown, options?: unknown) => {
    if (key !== SUBAGENT_WIDGET_KEY) {
      call(key, content, options);
      return;
    }
    const lines = Array.isArray(content) ? content.filter((line): line is string => typeof line === "string") : [];
    if (lines.length === 0) {
      collapseExploringBlock();
      call(key, undefined, options);
      return;
    }
    call(
      key,
      (tui: TUI, theme: Theme) => {
        const block = liveBlockFor(tui);
        block.calls = subagentCalls(lines, theme);
        block.collapsed = false;
        return liveComponent(tui, theme);
      },
      options,
    );
  }) as SetWidget;
  ui.setWidget = wrapped;
  skinnedContexts.add(ui);
}

/** Input fields that name what an exploration call looked at. */
function exploreDetail(name: string, input: Record<string, unknown>): string {
  const first = (value: unknown): string => (typeof value === "string" ? value : "");
  if (name === "read" || name === "ls") return first(input.path);
  if (name === "grep" || name === "ffgrep" || name === "find" || name === "fffind") {
    const pattern = first(input.pattern);
    const path = first(input.path);
    return name === "grep" || name === "ffgrep" ? (path ? `${pattern} in ${path}` : pattern) : pattern;
  }
  return "";
}

/**
 * Feed the chat the rows the live block showed, and settle the block when the
 * turn stops exploring: a finished turn keeps its rows in history, a report
 * arriving from a subagent settles the block on its own turn.
 */
export function installExploringBlock(pi: ModuleApi): void {
  installRenderMeasure();
  const width = columnWidth;

  pi.on("tool_result", (event, ctx) => {
    const name = event.toolName;
    if (name !== "read" && name !== "ls" && name !== "grep" && name !== "find" && name !== "ffgrep" && name !== "fffind" && name !== "subagent") {
      return;
    }
    if (event.isError) return;
    const theme = ctx.ui.theme;
    const calls = name === "subagent"
      ? exploringCalls(
          { content: event.content, details: event.details } as unknown as AgentToolResult<unknown>,
          false,
        )
      : [exploreCallFor(name, exploreDetail(name, event.input))];
    for (const call of calls) {
      void pi.sendMessage(
        { customType: EXPLORING_MESSAGE_TYPE, content: historyRow(call, theme, width()), display: true },
        { deliverAs: "nextTurn" },
      );
    }
  });

  pi.on("agent_settled", () => {
    collapseExploringBlock();
  });

  // A subagent report is a steering custom message; agent_end is the hook that
  // sees it, and the report's own turn settles the block.
  pi.on("agent_end", (event) => {
    if (event.messages.some(isSubagentReport)) collapseExploringBlock();
  });
}

/** A steering notification carrying a subagent report. */
function isSubagentReport(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  return (message as { customType?: unknown }).customType === SUBAGENT_COMPLETE_TYPE;
}
