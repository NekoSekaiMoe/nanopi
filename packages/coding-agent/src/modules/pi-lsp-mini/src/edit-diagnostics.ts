import type { ImageContent, TextContent } from "@nanopi/pi-ai";
import path from "node:path";
import { delay, formatDiagnostic } from "./manager.ts";
import type { LspManager } from "./manager.ts";
import type { EditDiagnosticsSettings } from "./settings.ts";
import type { Diagnostic } from "./lsp-types.ts";

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
 * Waits for a publish newer than `mark`, up to `timeoutMs`.
 *
 * "Newer" is the whole point: a server that answered `didOpen` before this edit
 * published a snapshot of the *previous* content, and handing that to the model
 * attributes errors the edit just fixed to the edit itself. Anything older than
 * the mark is dropped even when the budget runs out — reporting nothing is a
 * valid answer, reporting stale diagnostics is not.
 *
 * The initial `debounceMs` pause lets a server that publishes partial results
 * early finish the run it is already on, so the common case is one wait rather
 * than a poll loop.
 */
async function waitForFresh(
  manager: LspManager,
  file: string,
  mark: number,
  settings: EditDiagnosticsSettings,
  signal?: AbortSignal,
): Promise<{ serverId: string; diagnostics: Diagnostic[]; mark: number }[]> {
  const deadline = Date.now() + settings.timeoutMs;
  await delay(settings.debounceMs, signal);
  for (;;) {
    const fresh = manager.diagnosticsSince(file, mark);
    // An empty list from a server that published is an answer ("clean"); an
    // absent entry means it has not replied yet, so wait while the budget lasts.
    if (fresh.length >= manager.serverCountFor(file)) return fresh;
    if (Date.now() >= deadline) return fresh;
    await delay(200, signal).catch(() => undefined);
  }
}

/**
 * Re-reads a just-written file on its language server and returns the issues
 * for the *new* content.
 *
 * Two rules make this safe to attach to every edit:
 *
 * - Only publishes newer than the mark taken before the file was touched count.
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
  const mark = manager.markFor(absolute);

  try {
    const match = await manager.matchServer(absolute, context.cwd);
    if (!match) return NO_REPORT;

    const opened = await manager.openFile({ cwd: context.cwd, signal: context.signal }, absolute);
    if (!opened) return NO_REPORT;

    const fresh = await waitForFresh(manager, absolute, mark, settings, context.signal);
    if (fresh.length === 0) return NO_REPORT;

    const maxSeverity = settings.errorsOnly ? 1 : 2;
    const label = path.relative(context.cwd, absolute) || path.basename(absolute);
    const lines: string[] = [];
    let total = 0;
    for (const { serverId: _serverId, diagnostics } of fresh) {
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
