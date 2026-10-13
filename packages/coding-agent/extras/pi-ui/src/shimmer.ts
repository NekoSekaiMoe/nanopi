/**
 * omp-style working shimmer: a cosine "classic" band sweeps left -> right at a
 * fixed velocity over theme colors (dim -> muted -> accent, bold at the crest).
 * Ported from ref/packages/coding-agent/src/modes/theme/shimmer.ts, trimmed to
 * the classic sweep and Pi's Theme API.
 *
 * The band position is a phase accumulator (cells swept since the animation
 * started), NOT `time % period`: a modulo whose base depends on the current
 * text length teleports the band whenever the text width changes (e.g. the
 * elapsed counter growing `9s` -> `10s` or `59s` -> `1m 0s`). Advancing the
 * phase by clamped per-frame deltas instead keeps the sweep continuous across
 * width changes and prevents multi-cell jumps when the event loop stalls.
 */

import type { Theme, ThemeColor } from "@nanopi/pi-coding-agent";

/** Band travel speed in cells per second (fixed velocity, length-independent). */
const SHIMMER_SPEED_CELLS_PER_S = 30;
const CLASSIC_PADDING = 10;
const CLASSIC_BAND_HALF_WIDTH = 6;

/**
 * Cap on the wall-clock delta applied per frame. When the event loop stalls
 * (streaming bursts, full-tree renders), the band eases forward instead of
 * teleporting: 50 ms -> at most 1.5 cells per painted frame.
 */
const SWEEP_MAX_FRAME_DT_MS = 50;

const TIER_HIGH = 0.65;
const TIER_MID = 0.22;

const FG_RESET = "\x1b[39m";
const BOLD_OPEN = "\x1b[1m";
const BOLD_CLOSE = "\x1b[22m";

/** Three-tier color stack a character cycles through as the band sweeps. */
export interface ShimmerPalette {
  low: ThemeColor;
  mid: ThemeColor;
  high: ThemeColor;
  /** Bold the crest tier. */
  bold?: boolean;
}

/** One run of text sharing a palette inside a larger sweep. */
export interface ShimmerSegment {
  text: string;
  palette?: ShimmerPalette;
}

/** Working-message label: theme accent crest, bolded. */
export const MAIN_SHIMMER_PALETTE: ShimmerPalette = {
  low: "dim",
  mid: "muted",
  high: "accent",
  bold: true,
};

/** Trailing hint (elapsed · esc): quieter crest, no bold. */
export const HINT_SHIMMER_PALETTE: ShimmerPalette = {
  low: "dim",
  mid: "muted",
  high: "borderAccent",
};

type Tier = "low" | "mid" | "high";
type TierSeq = { open: string; close: string };
type CompiledPalette = Record<Tier, TierSeq>;

// Compiled ANSI pairs cached per palette, invalidated when the Theme instance
// changes (palettes are module constants, so a single-slot cache is enough).
const compiledCache = new WeakMap<ShimmerPalette, { theme: Theme; compiled: CompiledPalette }>();

function compile(theme: Theme, palette: ShimmerPalette): CompiledPalette {
  const cached = compiledCache.get(palette);
  if (cached && cached.theme === theme) return cached.compiled;
  const highColorOpen = theme.getFgAnsi(palette.high);
  const compiled: CompiledPalette = {
    low: { open: theme.getFgAnsi(palette.low), close: FG_RESET },
    mid: { open: theme.getFgAnsi(palette.mid), close: FG_RESET },
    high: palette.bold
      ? { open: `${BOLD_OPEN}${highColorOpen}`, close: `${BOLD_CLOSE}${FG_RESET}` }
      : { open: highColorOpen, close: FG_RESET },
  };
  compiledCache.set(palette, { theme, compiled });
  return compiled;
}

/** Smooth cosine bump centered at `pos`, in text-code-point space. */
function classicIntensity(pos: number, index: number): number {
  const dist = Math.abs(index + CLASSIC_PADDING - pos);
  if (dist >= CLASSIC_BAND_HALF_WIDTH) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * dist) / CLASSIC_BAND_HALF_WIDTH));
}

function tierFor(intensity: number): Tier {
  if (intensity >= TIER_HIGH) return "high";
  if (intensity >= TIER_MID) return "mid";
  return "low";
}

function countCodePoints(text: string): number {
  let count = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
    count++;
  }
  return count;
}

/**
 * Animated sweep state owned by the caller (one live sweep at a time).
 * `phase` is the band crest position in cells over the padded canvas;
 * `canvas` is the period the phase wraps at (text length + padding).
 */
export interface SweepState {
  phase: number;
  canvas: number;
}

export function resetSweep(state: SweepState): void {
  state.phase = 0;
  state.canvas = 0;
}

/**
 * Advance the sweep by `dtMs` of wall time (clamped) for a text of `total`
 * code points, keeping the crest position continuous when the canvas changes:
 * - canvas grows (e.g. `9s` -> `10s`): keep phase, wrap later than before;
 * - canvas shrinks below phase: park at the right edge until the next wrap.
 * Either way the band never teleports across the line.
 */
function advanceSweep(state: SweepState, dtMs: number, total: number): void {
  const canvas = total + CLASSIC_PADDING * 2;
  if (state.canvas !== canvas) {
    if (state.canvas !== 0 && canvas < state.phase) state.phase = canvas - 1;
    state.canvas = canvas;
  }
  const dt = Math.min(Math.max(dtMs, 0), SWEEP_MAX_FRAME_DT_MS);
  state.phase += (dt / 1000) * SHIMMER_SPEED_CELLS_PER_S;
  if (state.phase >= canvas) state.phase %= canvas;
}

/**
 * Animated variant used by the Working line: advances `state` by `dtMs` and
 * renders the sweep at the resulting phase.
 */
export function shimmerSegmentsAnimated(
  segments: readonly ShimmerSegment[],
  theme: Theme,
  state: SweepState,
  dtMs: number,
): string {
  let total = 0;
  for (const seg of segments) total += countCodePoints(seg.text);
  if (total === 0) return "";
  advanceSweep(state, dtMs, total);
  return shimmerSegments(segments, theme, state.phase);
}

/**
 * Render the sweep across one or more segments with the band crest at `pos`
 * (cells, over the padded canvas), treating the segments as a single
 * continuous string. Same-tier runs are coalesced so each frame emits a
 * handful of escape sequences, not one per code point.
 */
export function shimmerSegments(segments: readonly ShimmerSegment[], theme: Theme, pos: number): string {
  let total = 0;
  const perSeg: { text: string; palette: ShimmerPalette }[] = [];
  for (const seg of segments) {
    total += countCodePoints(seg.text);
    perSeg.push({ text: seg.text, palette: seg.palette ?? MAIN_SHIMMER_PALETTE });
  }
  if (total === 0) return "";

  // Fast-path window: outside [bandLo, bandHi] the intensity is guaranteed
  // zero (tier "low"), so the per-char intensity call is skipped there.
  const bandLo = pos - CLASSIC_PADDING - CLASSIC_BAND_HALF_WIDTH;
  const bandHi = pos - CLASSIC_PADDING + CLASSIC_BAND_HALF_WIDTH;

  let out = "";
  let index = 0;
  for (const { text, palette } of perSeg) {
    const compiled = compile(theme, palette);
    let runTier: Tier | null = null;
    let runStart = 0;
    let runEnd = 0;
    let i = 0;
    while (i < text.length) {
      // Keep surrogate pairs atomic; band position is measured in code points.
      const c = text.charCodeAt(i);
      const step = c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
      const tier: Tier = index < bandLo || index > bandHi ? "low" : tierFor(classicIntensity(pos, index));
      if (tier !== runTier) {
        if (runTier !== null && runEnd > runStart) {
          const seq = compiled[runTier];
          out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
        }
        runTier = tier;
        runStart = i;
      }
      runEnd = i + step;
      index++;
      i += step;
    }
    if (runTier !== null && runEnd > runStart) {
      const seq = compiled[runTier];
      out += `${seq.open}${text.slice(runStart, runEnd)}${seq.close}`;
    }
  }
  return out;
}

export function shimmerText(text: string, theme: Theme, palette?: ShimmerPalette): string {
  // Wall-clock phase for call sites without their own frame loop (retry /
  // compaction status, refreshed ~1/s by Pi's countdown timer).
  const total = countCodePoints(text);
  const pos = total === 0 ? 0 : ((Date.now() / 1000) * SHIMMER_SPEED_CELLS_PER_S) % (total + CLASSIC_PADDING * 2);
  return shimmerSegments([{ text, palette }], theme, pos);
}
