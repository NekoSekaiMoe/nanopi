import type { ImageContent, TextContent } from "@nanopi/pi-ai";
import path from "node:path";
import { formatDiagnostic } from "./manager.ts";
import type { LspManager } from "./manager.ts";
import type { EditDiagnosticsSettings } from "./settings.ts";

export interface EditDiagnosticsContext {
  cwd: string;
  signal?: AbortSignal;
}

export interface EditDiagnosticsReport {
  /** Formatted lines, empty when there is nothing to say. */
  lines: string[];
  serverId: string | undefined;
}

const NO_REPORT: EditDiagnosticsReport = { lines: [], serverId: undefined };

/**
 * Re-reads a just-written file on its language server and returns the issues
 * for the *new* content.
 *
 * Two rules make this safe to attach to every edit:
 *
 * - Only publishes newer than the one in flight when the edit finished count.
 *   Servers commonly publish the pre-edit snapshot once they finish the
 *   previous analysis, and reporting that snapshot as the outcome of this edit
 *   shows the model errors it already fixed — or errors it never introduced.
 * - Nothing here may fail the edit. A missing server, a crashed one, an
 *   unreadable file, or a timeout all produce no report.
 */
export async function collectEditDiagnostics(
  manager: LspManager,
  context: EditDiagnosticsContext,
  inputPath: string,
  settings: EditDiagnosticsSettings,
): Promise<EditDiagnosticsReport> {
  if (!settings.enabled) return NO_REPORT;

  const absolute = path.resolve(context.cwd, inputPath);
  const since = manager.currentRevision();

  try {
    const match = await manager.matchServer(absolute, context.cwd);
    if (!match) return NO_REPORT;

    const opened = await manager.openFile({ cwd: context.cwd, signal: context.signal }, absolute);
    if (!opened) return NO_REPORT;

    const settled = await manager.waitForDiagnosticsAfter(absolute, since, settings.timeoutMs, context.signal);
    if (!settled) return NO_REPORT;

    const fresh = manager.latestDiagnostics(absolute).filter((entry) => entry.revision > since);
    if (fresh.length === 0) return NO_REPORT;

    const maxSeverity = settings.errorsOnly ? 1 : 2;
    const label = path.relative(context.cwd, absolute) || path.basename(absolute);
    const lines: string[] = [];
    let total = 0;
    for (const { serverId, diagnostics } of fresh) {
      const kept = diagnostics.filter((diagnostic) => (diagnostic.severity ?? 1) <= maxSeverity);
      if (kept.length === 0) continue;
      total += kept.length;
      lines.push(...kept.slice(0, settings.maxDiagnostics).map((diagnostic) => formatDiagnostic(diagnostic)));
    }
    if (lines.length === 0) return NO_REPORT;

    return {
      lines: [`LSP ${total === 1 ? "issue" : `issues (${total})`} in ${label}:`, ...lines],
      serverId: fresh[0]?.serverId,
    };
  } catch {
    return NO_REPORT;
  }
}

/** Appends the report to a tool result's content blocks. Never mutates the input. */
export function appendReport(
  content: (TextContent | ImageContent)[],
  report: EditDiagnosticsReport,
): (TextContent | ImageContent)[] {
  if (report.lines.length === 0) return content;
  return [...content, { type: "text", text: `\n${report.lines.join("\n")}` }];
}
