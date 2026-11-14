import * as Diff from "diff";
import { theme } from "../theme/theme.ts";

/** Line separators beyond `\n` that a terminal would break the render on; such a line is not parseable. */
const UNSAFE_LINE_CHARS = /[\r\u2028\u2029]/;

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 *
 * Scanned by hand rather than matched with `^([+-\s])(\s*\d*)\s(.*)$`: that
 * regex has two ways to split a whitespace run, so a line with a long blank
 * prefix backtracks once per split point (a 100k-space prefix froze the
 * renderer for seconds).
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	if (line.length === 0 || UNSAFE_LINE_CHARS.test(line)) return null;
	const prefix = line[0];
	if (prefix !== "+" && prefix !== "-" && prefix !== " " && prefix !== "\t") return null;

	let cursor = 1;
	while (cursor < line.length && isBlank(line[cursor])) cursor++;
	const digitsStart = cursor;
	while (cursor < line.length && line[cursor] >= "0" && line[cursor] <= "9") cursor++;
	const lineNum = line.slice(digitsStart, cursor);

	// The single terminator space is the renderer's own column separator, so a
	// line that has no digits must still carry it before its content.
	if (cursor >= line.length || line[cursor] !== " ") return null;
	return { prefix, lineNum, content: line.slice(cursor + 1) };
}

function isBlank(char: string): boolean {
	return char === " " || char === "\t";
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Inverse video for a changed run. Whitespace-only runs are left unstyled: highlighting
 * blank cells adds noise and, before the whitespace fix, invited dropping them entirely.
 */
function inverseOf(value: string): string {
	return value.trim() === "" ? value : theme.inverse(value);
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWordsWithSpace, not diffWords: diffWords ignores whitespace when matching and
 * then re-attaches it to whichever run comes first, so a `-`/`+` pair that only differs in
 * indentation used to lose the removed line's leading spaces and stop lining up.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWordsWithSpace(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";

	for (const part of wordDiff) {
		if (part.removed) {
			removedLine += inverseOf(part.value);
		} else if (part.added) {
			addedLine += inverseOf(part.value);
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (p?.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
				result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${replaceTabs(removed.content)}`));
				}
				for (const added of addedLines) {
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${replaceTabs(added.content)}`));
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(theme.fg("toolDiffAdded", `+${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		} else {
			// Context line
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}
