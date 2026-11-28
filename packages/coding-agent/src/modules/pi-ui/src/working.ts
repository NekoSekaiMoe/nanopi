/**
 * The one-line Working row: an animated shimmer over the current todo step
 * (or the plain "Working" label), plus the "Worked for Ns" transcript entry
 * written when the turn settles. Colours follow the active theme's tokens, so
 * a theme switch needs no reinstall.
 */

import type {
  ModuleActionsSurface,
  ModuleContext,
  ModuleEventsSurface,
  ModuleRenderingSurface,
  Theme,
  WorkingIndicatorRenderer,
  WorkingIndicatorState,
} from "@nanopi/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@nanopi/pi-tui";
import { fgRgb, sampleGradient, type Rgb } from "./gradient.ts";
import { HINT_SHIMMER_PALETTE, MAIN_SHIMMER_PALETTE, shimmerSegmentsAnimated, type SweepState } from "./shimmer.ts";

const ELAPSED_ENTRY_TYPE = "pi-ui-elapsed";
const MAX_STEP_CHARS = 48;
/** Below this many step characters the fold marker costs more than it explains. */
const MIN_STEP_CHARS = 12;
/** Status row prefix: the dot, a space, and the one-cell margin the row keeps. */
const ROW_PREFIX_COLS = 4;
const HINT_SUFFIX = " · esc to interrupt)";

/** One sweep per row: retry can appear while the working row is still mounted. */
const sweeps = new Map<string, SweepState>();

function sweepFor(key: string): SweepState {
  let sweep = sweeps.get(key);
  if (!sweep) {
    sweep = { phase: 0, canvas: 0 };
    sweeps.set(key, sweep);
  }
  return sweep;
}

/**
 * Breathing dot beside the working shimmer. One glyph per 100 ms frame,
 * matching the spinner cadence the reference uses. `∙` and `⋅` are East Asian
 * Width neutral, so the row keeps one cell at every frame (unlike `•`/`·`,
 * which are ambiguous-width and shift a CJK terminal). The dot grows into a
 * star, flares, then rests before fading back to a point.
 */
const DOT_BLUE: Rgb = [71, 150, 227];
const DOT_PURPLE: Rgb = [145, 119, 199];
const DOT_BREATH: readonly (readonly [string, number, number])[] = [
  ["∙", 0.2, 0], ["∙", 0.3, 0], ["⋅", 0.4, 0.1], ["⋅", 0.5, 0.2],
  ["✦", 0.6, 0.4], ["✦", 0.8, 0.7], ["✦", 1.0, 1.0], ["✦", 0.85, 0.8],
  ["✦", 0.7, 0.5], ["✦", 0.6, 0.2], ["✦", 0.5, 0], ["✦", 0.5, 0],
  ["✦", 0.5, 0], ["✦", 0.5, 0], ["✦", 0.5, 0], ["✦", 0.5, 0],
  ["✦", 0.5, 0], ["✦", 0.5, 0], ["✦", 0.5, 0], ["✦", 0.4, 0],
  ["⋅", 0.35, 0], ["∙", 0.25, 0], ["∙", 0.2, 0], ["∙", 0.2, 0],
];
const DOT_FRAME_MS = 100;

/**
 * Dot frame for a point in the turn. The breath period is fixed (unlike the
 * shimmer band, whose canvas changes with text width), so wall time addresses
 * the frame directly: no accumulator to drift or jump when a frame is missed.
 */
function breathingDot(elapsedMs: number): string {
  const frame = Math.floor(Math.max(0, elapsedMs) / DOT_FRAME_MS) % DOT_BREATH.length;
  const [glyph, light, hue] = DOT_BREATH[frame]!;
  const tone = sampleGradient([DOT_BLUE, DOT_PURPLE], hue);
  const color: Rgb = light < 0.5
    ? [Math.round((tone[0] * light) / 0.5), Math.round((tone[1] * light) / 0.5), Math.round((tone[2] * light) / 0.5)]
    : [
        Math.round(tone[0] + (255 - tone[0]) * (light - 0.5) * 0.9),
        Math.round(tone[1] + (255 - tone[1]) * (light - 0.5) * 0.9),
        Math.round(tone[2] + (255 - tone[2]) * (light - 0.5) * 0.9),
      ];
  return fgRgb(glyph, color);
}

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
  const withDot = `${breathingDot(elapsedMs)} ${line}`;
  if (terminalColumns <= 0 || visibleWidth(withDot) <= terminalColumns - 1) return withDot;
  // Last resort for a terminal too narrow for the per-step budget: fold the
  // whole row rather than let it wrap and break the editor frame.
  return truncateToWidth(withDot, terminalColumns - 1, "…");
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
    const withDot = `${breathingDot(state.elapsedMs)} ${line}`;
    const columns = state.columns > 0 ? state.columns : terminalColumns;
    if (columns > 0 && visibleWidth(withDot) > columns - 1) {
      return { text: truncateToWidth(withDot, columns - 1, "…") };
    }
    return { text: withDot };
  };
}

/**
 * The same shimmer covers the retry and compaction status rows. The host owns
 * the text (attempt count, countdown, cancel hint), so a renderer only restyles
 * it; other modules keep their default spinner when they register a row of
 * their own. Exported for the pi-ui tests; the registered renderer is the only
 * production caller.
 */
export function statusRowRenderer(state: WorkingIndicatorState, activeTheme: Theme): { text: string } | undefined {
  if (state.kind !== "retry" && state.kind !== "compaction") return undefined;
  const sweep = sweepFor(state.kind);
  const text = shimmerSegmentsAnimated([{ text: state.message }], activeTheme, sweep, state.dtMs);
  const columns = state.columns > 0 ? state.columns : terminalColumns;
  if (columns > 0 && visibleWidth(text) > columns - 1) {
    return { text: truncateToWidth(text, columns - 1, "…") };
  }
  return { text };
}

export function installWorking(
  pi: ModuleRenderingSurface & ModuleEventsSurface & ModuleActionsSurface,
): () => void {
  let startedAt: number | undefined;

  pi.registerWorkingIndicator(workingRowRenderer());
  pi.registerWorkingIndicator(statusRowRenderer, ["retry", "compaction"]);

  pi.registerEntryRenderer(ELAPSED_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { elapsedMs?: unknown } | undefined;
    const elapsedMs = typeof data?.elapsedMs === "number" ? data.elapsedMs : 0;
    return new Text(theme.fg("dim", `Worked for ${formatElapsed(elapsedMs)}`), 0, 0);
  });

  pi.on("session_start", () => {
    planTodos = [];
  });

  // Mirror the todo extension's plan from its result details. The tool's own
  // execute stays untouched; this only drives the Working-line label.
  pi.on("tool_result", (event) => {
    syncPlanFromToolResult(event);
  });

  pi.on("agent_start", () => {
    if (startedAt === undefined) startedAt = Date.now();
  });

  pi.on("agent_settled", () => {
    if (startedAt !== undefined) {
      pi.appendEntry(ELAPSED_ENTRY_TYPE, { elapsedMs: Date.now() - startedAt });
      startedAt = undefined;
    }
  });

  const cleanup = () => {
    startedAt = undefined;
    planTodos = [];
  };

  pi.on("session_shutdown", cleanup);
  return cleanup;
}
