/** Codex-style single line below the editor: `used xk/yk · / for more details`. */

import type {
  ModuleContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@nanopi/pi-coding-agent";
import type { Component, TUI } from "@nanopi/pi-tui";
import { truncateToWidth } from "@nanopi/pi-tui";
import type { ReferenceUiState } from "./state.ts";
import { captureRenderTrigger } from "./thinking.ts";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function resolveUsedTokens(ctx: ModuleContext): number | null {
  const usage = ctx.getContextUsage();
  if (usage?.tokens !== null && usage?.tokens !== undefined) return usage.tokens;
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  if (usage?.percent !== null && usage?.percent !== undefined && contextWindow > 0) {
    return Math.round((usage.percent / 100) * contextWindow);
  }
  return null;
}

function renderToolbarLine(
  ctx: ModuleContext,
  theme: Theme,
  _footerData: ReadonlyFooterDataProvider,
  _uiState: ReferenceUiState,
  width: number,
): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const used = resolveUsedTokens(ctx);
  const line = `used ${used === null ? "?" : formatTokens(used)}/${formatTokens(contextWindow)} · / for more details`;
  return truncateToWidth(theme.fg("dim", line), Math.max(0, width), theme.fg("dim", "…"));
}

export function installFooter(ctx: ModuleContext, uiState: ReferenceUiState): void {
  ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider): Component & { dispose?(): void } => {
    // Hand the TUI to thinking.ts so landed summaries can repaint at once;
    // the footer factory is the one place pi-ui still receives it.
    captureRenderTrigger(tui);
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        return width > 0 ? [renderToolbarLine(ctx, theme, footerData, uiState, width)] : [];
      },
    };
  });
}
