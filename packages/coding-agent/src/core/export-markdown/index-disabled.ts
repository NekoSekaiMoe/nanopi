/**
 * Stand-in for the Markdown export in a build whose flavor disables the
 * "export-markdown" component (buildconfig.json).
 *
 * agent-session and the CLI import the real module statically, so the build
 * swaps this file in at resolve time; every export name of the module has to
 * exist here or the bundle fails to link.
 */

import type { ReadonlySessionManager } from "../session-manager.ts";

export interface MarkdownExportOptions {
	outputPath?: string;
	title?: string;
}

const MESSAGE =
	'Markdown export is not included in this build (buildconfig.json component "export-markdown" is disabled)';

export function renderSessionMarkdown(_sessionManager: ReadonlySessionManager, _title?: string): string {
	throw new Error(MESSAGE);
}

export function exportSessionToMarkdown(
	_sessionManager: ReadonlySessionManager,
	_options?: MarkdownExportOptions | string,
): string {
	throw new Error(MESSAGE);
}
