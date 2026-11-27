import fs from "node:fs/promises";
import path from "node:path";
import { delay, formatDiagnostic } from "./manager.ts";
import type { EditDiagnosticsReport } from "./edit-diagnostics.ts";
import type { LspManager } from "./manager.ts";
import type { Diagnostic } from "./lsp-types.ts";
import type { ReadDiagnosticsSettings } from "./settings.ts";

export interface ReadDiagnosticsContext {
	cwd: string;
	signal?: AbortSignal;
}

/** Same shape as the post-edit report: `appendReport` puts both into a tool result. */
export type ReadDiagnosticsReport = EditDiagnosticsReport;

const NO_REPORT: ReadDiagnosticsReport = { lines: [], serverId: undefined };

/**
 * Attaches the errors a file already has to its read result.
 *
 * The read result is where the model looks at code for the first time in a
 * turn. Finding out afterwards, from a post-edit report or a failing test, that
 * the file it just read is already broken costs a whole extra round: it edits
 * on top of a broken file, or starts debugging a problem that predates it. One
 * paragraph in the same message is the whole fix.
 *
 * Three things keep it off the critical path:
 *
 * - A tool result hook can only *replace* content, never delay the result by
 *   more than the hook itself takes, so the wait is bounded by `timeoutMs`
 *   (4s by default) and a slow server costs a slightly late read, not a hang.
 * - A diagnostic pushed before the `didOpen` for this read describes whatever
 *   the server last saw, which may be an older version of the file. The
 *   revision gate takes the mark before opening and only accepts a report
 *   published after it, then waits up to `timeoutMs` for servers that publish
 *   on demand.
 * - Nothing here may fail the read: no server, a dead one, a file too large, or
 *   a timeout all mean "no report".
 */
export async function collectReadDiagnostics(
	manager: LspManager,
	context: ReadDiagnosticsContext,
	inputPath: string,
	settings: ReadDiagnosticsSettings,
): Promise<ReadDiagnosticsReport> {
	if (!settings.enabled) return NO_REPORT;

	const absolute = path.resolve(context.cwd, inputPath);
	try {
		const stat = await fs.stat(absolute);
		if (!stat.isFile() || stat.size > settings.maxFileBytes) return NO_REPORT;

		const mark = manager.markFor(absolute);
		const opened = await manager.openFile({ cwd: context.cwd, signal: context.signal }, absolute);
		if (!opened) return NO_REPORT;

		const fresh = await waitForPublish(manager, absolute, mark, settings.timeoutMs, context.signal);
		const kept: Diagnostic[] = [];
		for (const entry of fresh) {
			for (const diagnostic of entry.diagnostics) {
				if ((diagnostic.severity ?? 1) <= settings.maxSeverity) kept.push(diagnostic);
			}
		}
		if (kept.length === 0) return NO_REPORT;

		const label = path.relative(context.cwd, absolute) || path.basename(absolute);
		return {
			serverId: fresh[0]?.serverId,
			lines: [
				`LSP reports ${kept.length} existing error${kept.length > 1 ? "s" : ""} in ${label} (unrelated to any change you have not made yet):`,
				...kept.slice(0, settings.maxDiagnostics).map((diagnostic) => formatDiagnostic(diagnostic)),
			],
		};
	} catch {
		return NO_REPORT;
	}
}

/**
 * Waits for a publish newer than `mark`.
 *
 * A server that answers `didOpen` with a publish of the content it was already
 * holding would give a stale answer; the mark is what separates the two. One
 * fresh publish is enough to answer, because a server only publishes when it
 * has something to say about the document it just received: an empty list is
 * still a publish, so "clean" arrives through the same path as "broken".
 */
async function waitForPublish(
	manager: LspManager,
	file: string,
	mark: number,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ serverId: string; diagnostics: Diagnostic[] }[]> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const fresh = manager.diagnosticsSince(file, mark);
		if (fresh.length > 0 || Date.now() >= deadline) return fresh;
		await delay(100, signal).catch(() => undefined);
		if (signal?.aborted) return fresh;
	}
}
