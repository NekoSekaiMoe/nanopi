/** Animated omp-style status shimmer and elapsed transcript row. */

import type { ModuleApi, Theme, WorkingIndicatorRenderer } from "@nanopi/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@nanopi/pi-tui";
import { HINT_SHIMMER_PALETTE, MAIN_SHIMMER_PALETTE, shimmerSegmentsAnimated, type SweepState } from "./shimmer.ts";

const ELAPSED_ENTRY_TYPE = "pi-ui-elapsed";
const MAX_STEP_CHARS = 48;
/** Below this many step characters the fold marker costs more than it explains. */
const MIN_STEP_CHARS = 12;
/** Status row prefix: spinner dot, a space, and the one-cell margin the row keeps. */
const ROW_PREFIX_COLS = 4;
const HINT_SUFFIX = " · esc to interrupt)";

/** Theme captured from the latest event context. */
let activeTheme: Theme | undefined;
/** Terminal width captured from the footer factory; the working row is one line. */
let terminalColumns = 0;

/**
 * Capture the width the working row is rendered into. The row lives inside the
 * editor's top border, so it must fold itself: an overlong message would wrap
 * onto a second line and break the frame.
 */
export function captureTerminalWidth(columns: number): void {
  terminalColumns = columns;
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Mirror of the todo extension's list, synced from its tool_result details. */
interface MirroredTodo {
  text: string;
  status: string;
}

interface PlanStep {
  done: number;
  total: number;
  text: string;
}

let planTodos: MirroredTodo[] = [];

/** Exported for the pi-ui tests; `tool_result` is the only production caller. */
export function syncPlanFromToolResult(event: { toolName: string; details?: unknown }): void {
  if (event.toolName !== "todo") return;
  const details = event.details as { todos?: unknown } | undefined;
  const raw = Array.isArray(details?.todos) ? details.todos : [];
  planTodos = raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      text: typeof item.text === "string" ? item.text : "",
      status: typeof item.status === "string" ? item.status : "pending",
    }));
}

/**
 * Shorten a long step so the row still reads as a sentence that continues.
 *
 * A tail truncation ("Implement the working row foldi…") reads like a broken
 * word. A hard cut at the head ("Implement") loses what the step actually
 * does. So keep the head of the step and close it with a bracket that says the
 * rest is in flight, mirroring the parenthesized elapsed counter:
 *   Implement the working row folding (working …)
 * The brackets shrink to "(…)" and then to "…" when the terminal is too
 * narrow for the wording.
 */
function foldStep(text: string, budget: number): string {
  if ([...text].length <= Math.min(MAX_STEP_CHARS, budget)) return text;
  const limit = Math.max(1, Math.min(MAX_STEP_CHARS, budget));
  for (const marker of [" (working …)", " (…)", "…"]) {
    const keep = limit - [...marker].length;
    if (keep >= MIN_STEP_CHARS) return `${[...text].slice(0, keep).join("").trimEnd()}${marker}`;
  }
  return `${[...text].slice(0, limit).join("")}…`;
}

/** Seconds left for the step once the elapsed hint and the row prefix are paid for. */
function stepBudget(): number {
  if (terminalColumns <= 0) return MAX_STEP_CHARS;
  const hint = ` (0m 0s${HINT_SUFFIX}`;
  return terminalColumns - ROW_PREFIX_COLS - [...hint].length;
}

/** Current step while a plan has open todos; undefined once it finishes. */
function currentPlanStep(): PlanStep | undefined {
  if (planTodos.length === 0) return undefined;
  const open = planTodos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled");
  if (open.length === 0) return undefined;
  const current = open.find((todo) => todo.status === "in_progress") ?? open[0]!;
  return {
    done: planTodos.length - open.length,
    total: planTodos.length,
    text: foldStep(current.text, stepBudget()),
  };
}

/** Exported for the pi-ui tests; the working row renderer is the only production caller. */
export function workingMessage(theme: Theme, elapsedMs: number, sweep: SweepState, dtMs: number): string {
  const step = currentPlanStep();
  // While a todo plan is being implemented, the step list replaces the word
  // "Working"; a finished/cleared plan falls back to the plain label.
  const label = step ? `${step.done}/${step.total} ${step.text}` : "Working";
  const hint = ` (${formatElapsed(elapsedMs)} · esc to interrupt)`;
  const line = shimmerSegmentsAnimated(
    [
      { text: label, palette: MAIN_SHIMMER_PALETTE },
      { text: hint, palette: HINT_SHIMMER_PALETTE },
    ],
    theme,
    sweep,
    dtMs,
  );
  if (terminalColumns <= 0 || visibleWidth(line) <= terminalColumns - 1) return line;
  // Last resort for a terminal too narrow for the per-step budget: fold the
  // whole row rather than let it wrap and break the editor frame.
  return truncateToWidth(line, terminalColumns - 1, "…");
}

/**
 * The working line, as a `registerWorkingIndicator` row. The core hands the
 * row its message, elapsed time, and width, so this module no longer needs to
 * drive `setWorkingMessage` on a frame timer or patch Loader.
 */
function workingRowRenderer(): WorkingIndicatorRenderer {
  const sweep: SweepState = { phase: 0, canvas: 0 };
  return (state, theme) => {
    if (state.placement === "none") return { text: "", hidden: true };
    // The host's message is `setWorkingMessage()`, or the default
    // "Working (0s · esc to interrupt)" when nothing set one. A todo plan
    // replaces the word "Working" with the current step.
    const step = currentPlanStep();
    const label = step ? `${step.done}/${step.total} ${step.text}` : "Working";
    const hint = ` (${formatElapsed(state.elapsedMs)} · esc to interrupt)`;
    const line = shimmerSegmentsAnimated(
      [
        { text: label, palette: MAIN_SHIMMER_PALETTE },
        { text: hint, palette: HINT_SHIMMER_PALETTE },
      ],
      theme,
      sweep,
      state.dtMs,
    );
    const columns = state.columns > 0 ? state.columns : terminalColumns;
    if (columns > 0 && visibleWidth(line) > columns - 1) {
      return { text: truncateToWidth(line, columns - 1, "…") };
    }
    return { text: line };
  };
}

export function installWorking(pi: ModuleApi): () => void {
  let startedAt: number | undefined;

  pi.registerWorkingIndicator(workingRowRenderer());

  pi.registerEntryRenderer(ELAPSED_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { elapsedMs?: unknown } | undefined;
    const elapsedMs = typeof data?.elapsedMs === "number" ? data.elapsedMs : 0;
    return new Text(theme.fg("dim", `Worked for ${formatElapsed(elapsedMs)}`), 0, 0);
  });

  pi.on("session_start", (_event, ctx) => {
    planTodos = [];
    if (ctx.mode !== "tui") return;
    activeTheme = ctx.ui.theme;
  });

  // Mirror the todo extension's plan from its result details. The tool's own
  // execute stays untouched; this only drives the Working-line label.
  pi.on("tool_result", (event) => {
    syncPlanFromToolResult(event);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTheme = ctx.ui.theme;
    if (startedAt === undefined) startedAt = Date.now();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (startedAt !== undefined) {
      pi.appendEntry(ELAPSED_ENTRY_TYPE, { elapsedMs: Date.now() - startedAt });
      startedAt = undefined;
    }
  });

  const cleanup = () => {
    startedAt = undefined;
    planTodos = [];
    activeTheme = undefined;
  };

  pi.on("session_shutdown", cleanup);
  return cleanup;
}
