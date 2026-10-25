/**
 * Export formats a session can be written as, and the build flavor that
 * carries each one.
 *
 * `buildconfig.json` splits export into two components so a trimmed build
 * ships only what it advertises: `export-markdown` (Markdown) and
 * `export-html` (HTML plus the templates it reads from disk). Nobody writes a
 * PDF: the PDF is the HTML export document printed by a browser, which needs
 * no code from this build (issue #187).
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

/**
 * Parse a format name or a file extension. `pdf` is not a format this build
 * writes, but it parses to itself so the caller can answer with the hint
 * instead of silently writing HTML under a `.pdf` name.
 */
export function parseExportFormat(value: string): SessionExportFormat | "pdf" | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "pdf") return "pdf";
	return FORMAT_ALIASES[normalized];
}

export function isExportFormatEnabled(format: SessionExportFormat): boolean {
	const component = FORMAT_COMPONENT[format];
	return component === undefined || isBuildComponentEnabled(component);
}

/** The formats this build can write, in the order the UI lists them. */
export function enabledExportFormats(): SessionExportFormat[] {
	return (["md", "html"] as const).filter(isExportFormatEnabled);
}

/** Why a build without the export component refuses a format, spelled for an error message. */
export function formatNotIncludedMessage(format: SessionExportFormat): string {
	if (format === "jsonl") return "The JSONL export is the session file itself and has no build component";
	return `${format.toUpperCase()} export is not included in this build (buildconfig.json component "${FORMAT_COMPONENT[format]}" is disabled)`;
}

/** What to do instead of asking for a PDF: the HTML export is the printable document. */
export function pdfExportHint(): string {
	return (
		"PDF export is not part of nanopi: export HTML and print that document to PDF from a browser " +
		"(open the file, then Print > Save as PDF)"
	);
}
