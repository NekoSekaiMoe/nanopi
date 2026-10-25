/**
 * Export formats a session can be written as, and the build flavor that
 * carries each one.
 *
 * `buildconfig.json` splits export into two components so a trimmed build
 * ships only what it advertises: `export-markdown` (Markdown) and
 * `export-html` (HTML plus the templates it reads from disk). There is no PDF
 * writer: a PDF is the HTML export printed by the browser, so the two formats
 * a build carries are the two it writes.
 */

import { isBuildComponentEnabled } from "../build-components.ts";

export type SessionExportFormat = "md" | "html" | "jsonl";

/** Component that has to be in the build for a format to work. */
const FORMAT_COMPONENT: Record<SessionExportFormat, string | undefined> = {
	md: "export-markdown",
	html: "export-html",
	// The JSONL export is the session file itself; no component gates it.
	jsonl: undefined,
};

const FORMAT_ALIASES: Record<string, SessionExportFormat> = {
	md: "md",
	markdown: "md",
	html: "html",
	htm: "html",
	jsonl: "jsonl",
};

/** Normalize a format name or file extension, or undefined when it is not one of them. */
export function parseExportFormat(value: string): SessionExportFormat | undefined {
	return FORMAT_ALIASES[value.trim().toLowerCase()];
}

export function isExportFormatEnabled(format: SessionExportFormat): boolean {
	const component = FORMAT_COMPONENT[format];
	return component === undefined || isBuildComponentEnabled(component);
}

/** The formats this build can write, in the order the UI lists them. */
export function enabledExportFormats(): SessionExportFormat[] {
	return (["md", "html"] as const).filter(isExportFormatEnabled);
}

/** Formats a build without the export components refuses, spelled for an error message. */
export function formatNotIncludedMessage(format: SessionExportFormat): string {
	if (format === "jsonl") return "The JSONL export is the session file itself and has no build component";
	return `${format.toUpperCase()} export is not included in this build (buildconfig.json component "${FORMAT_COMPONENT[format]}" is disabled)`;
}
