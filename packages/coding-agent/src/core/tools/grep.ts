import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@nanopi/pi-agent-core";
import { spawn } from "child_process";
import { minimatch } from "minimatch";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ModuleContext, ToolDefinition } from "../modules/types.ts";
import { relativeToRoot, walkFiles } from "./fallback-walker.ts";
import { resolveToCwd } from "./path-utils.ts";
import { grepRenderers } from "./renderers/grep.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({
		description: "Search pattern (regex or literal string)",
	}),
	path: Type.Optional(
		Type.String({
			description: "Directory or file to search (default: current directory)",
		}),
	),
	glob: Type.Optional(
		Type.String({
			description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
		}),
	),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({
			description: "Treat pattern as literal string instead of regex (default: false)",
		}),
	),
	context: Type.Optional(
		Type.Number({
			description: "Number of lines to show before and after each match (default: 0)",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: "Maximum number of matches to return (default: 100)",
		}),
	),
});

export const grepToolSystemPromptContribution = {
	snippet: "Search file contents",
	guidelines: [],
} as const;

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;
/** Matches kept for any single file, so one chatty file cannot spend the whole limit. */
const PER_FILE_LIMIT = 20;
/** A formatted match line (`path:line: text`), as opposed to a context line (`path-line- text`). */
const MATCH_LINE = /:\d+: /;
/** Files named in the "more matches than shown" notice before it summarizes the rest. */
const TRIMMED_FILES_NAMED = 3;
/** Appended when ripgrep is missing and the in-process walker ran instead. */
const FALLBACK_NOTICE =
	"ripgrep (rg) was not found, so this search used a slower in-process walker with the same ignore rules. Call grep normally; install ripgrep to make searches faster";

/** A file whose matches were not all shown, and how many were dropped. */
export interface GrepTrimmedFile {
	file: string;
	/** Matches kept for this file (0 when the file was not searched at all). */
	shown: number;
	/** Matches ripgrep reported but the tool did not print. */
	omitted: number;
}

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	/** True when ripgrep was stopped before it finished, so files were never searched. */
	stoppedEarly?: boolean;
	/** Files that lost matches to the limit or to byte truncation. */
	trimmedFiles?: GrepTrimmedFile[];
	/** True when ripgrep was missing, so the in-process walker ran instead. */
	fallback?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

/**
 * The in-process walker must match what ripgrep matches: one line at a time,
 * literal mode through a regex escape, and a pattern that does not compile
 * surfacing the same failure the binary would exit with.
 */
function compilePattern(pattern: string, options: { ignoreCase?: boolean; literal?: boolean }): RegExp {
	// Escaped by hand: the regex escape helper is not in the runtime the CLI targets.
	const source = options.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern;
	try {
		return new RegExp(source, options.ignoreCase ? "i" : "");
	} catch (error) {
		throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * `glob` narrows both implementations, but not the same way. ripgrep applies it
 * to the file name, so `*.ts` matches `src/a.ts` at any depth; minimatch would
 * read that pattern as root-only. A `**` slash prefix keeps the ripgrep reading;
 * a pattern that already contains a slash keeps its own path meaning.
 */
function compilePathGlob(glob: string): (relativePath: string) => boolean {
	const pattern = glob.includes("/") ? glob : `**/${glob}`;
	return (relativePath) => minimatch(relativePath, pattern, { dot: true });
}

/** ripgrep arguments for one search. `--no-config` keeps the tool contract out of RIPGREP_CONFIG_PATH. */
function ripgrepArgs(
	pattern: string,
	searchPath: string,
	options: {
		ignoreCase?: boolean;
		literal?: boolean;
		glob?: string;
		context?: number;
		isDirectory?: boolean;
	},
): string[] {
	const args: string[] = ["--no-config", "--json", "--line-number", "--color=never", "--hidden"];
	if (options.ignoreCase) args.push("--ignore-case");
	if (options.literal) args.push("--fixed-strings");
	if (options.glob) args.push("--glob", options.glob);
	// ripgrep sends the surrounding lines as `context` events, so a matched file is never
	// read here. Reading it meant an 8 x 95 MB log with `context: 2` loaded whole files.
	if (options.context) args.push("--context", String(options.context));
	// ripgrep roots --glob at its own cwd, not at the search path, so a directory search
	// runs inside searchPath: `path: "repo", glob: "migrations/main/*.js"` answered
	// "No matches found" because the glob was resolved against the directory nanopi started
	// in. "." rather than the absolute path because ripgrep canonicalizes its cwd, and a
	// symlinked searchPath (macOS /tmp) would no longer lie under the glob root.
	args.push("--", pattern, options.isDirectory ? "." : searchPath);
	return args;
}

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents; respects .gitignore. Truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB; long lines to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ModuleContext,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const rgPath = await ensureTool("rg");

						const searchPath = resolveToCwd(searchDir || ".", ctx?.cwd || cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						// Clamp so String() never yields exponent notation, which ripgrep rejects.
						const contextValue =
							context && context > 0 ? Math.min(Math.floor(context), Number.MAX_SAFE_INTEGER) : 0;
						// A fractional limit used to reach the notice verbatim (`1.5` in "1.5 matches limit
						// reached"), and `limit: 0` was read as "no limit" because recordMatch compared
						// against the raw value.
						const effectiveLimit = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								// ripgrep reports paths relative to its cwd, which is searchPath for a
								// directory search (`./main/0001.js`), while the in-process walker
								// reports absolute ones.
								const relative = path.relative(searchPath, path.resolve(searchPath, filePath));
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						/** The walker, which has no ripgrep events to read context lines from, so it loads the file. */
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									// Split on \n only: ripgrep counts \n (and a lone \r it treats as one too), so
									// turning every \r into a line break shifted every line number after an
									// isolated CR and printed the wrong context. \r is stripped per line later.
									lines = content.split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						// Context lines no ripgrep means the walker, and the walker has to read the
						// file. ripgrep sends them as `context` events, so no file is read here.
						const child = rgPath
							? spawn(
									rgPath,
									ripgrepArgs(pattern, searchPath, {
										ignoreCase,
										literal,
										glob,
										context: contextValue,
										isDirectory,
									}),
									{
										// --glob is rooted at the child's cwd (#634), so the search path has to
										// be inside it or the glob means something else entirely.
										cwd: isDirectory ? searchPath : undefined,
										stdio: ["ignore", "pipe", "pipe"],
									},
								)
							: null;
						const rl = child ? createInterface({ input: child.stdout }) : null;
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						// Set at the last allowed match. Its trailing context is still kept up to
						// trailingContextEnd, and a match outside that window proves the limit cut
						// results off, so the walk stops instead of scanning the rest.
						let limitHit = false;
						let trailingContextEnd = 0;
						let trailingFile: string | undefined;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						let stoppedEarly = false;
						// No ripgrep means the in-process walker runs instead, and that is the only
						// time the model pays for the notice: a missing binary is not a detail it
						// can discover from the output, and the walker is slower.
						const fallback = rgPath === undefined;
						const outputLines: string[] = [];
						// Rows printed straight from ripgrep's stream, which is where every match and
						// context line comes from when ripgrep is available. Kept apart from
						// outputLines because outputLines is rebuilt by `finish` and must stay
						// ordered as the walker printed it.
						const printedLines: string[] = [];
						// Per-file budget: without it one chatty file spends the whole global
						// match limit and the handful of files ripgrep had already scanned are
						// all the model gets, with no sign that the rest were never searched.
						const perFileLimit = Math.min(PER_FILE_LIMIT, effectiveLimit);
						const fileMatchCounts = new Map<string, number>();
						// Output line -> the file it describes, so the notices can count what
						// survived byte truncation without re-parsing the formatted text.
						const lineDisplay = new Map<string, string>();
						// Match lines a file contributed. Counted when the match is accepted, not when
						// its line is printed, so a file that printed everything it had is not named
						// in the notice.
						const keptByFile = new Map<string, number>();
						// Matches collected by the walker, which has no stream to format events
						// from; ripgrep's lines are printed as they arrive.
						const matches: Array<{
							filePath: string;
							lineNumber: number;
							lineText?: string;
						}> = [];
						/** Lines of the run being printed: the leading context first, then the matches. */
						const blockRows: Array<{
							filePath: string;
							lineNumber: number;
							lineText: string;
							isMatch: boolean;
						}> = [];
						/** A match that arrived right after context: the run may continue, or restart. */
						let pendingMatch: { filePath: string; lineNumber: number; lineText: string } | undefined;
						// Matches ripgrep reported for a file that was already over its own
						// budget. Counted, never printed, so the notice can say how much was
						// dropped instead of silently losing it.
						const overflow = new Map<string, number>();

						const cleanup = () => {
							rl?.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (child && !child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });

						const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
							const start = Math.max(1, lineNumber - contextValue);
							const end = Math.min(lines.length, lineNumber + contextValue);
							const rows: Array<{
								lineNumber: number;
								lineText: string;
								isMatch: boolean;
							}> = [];
							for (let current = start; current <= end; current++) {
								rows.push({
									lineNumber: current,
									lineText: lines[current - 1] ?? "",
									isMatch: current === lineNumber,
								});
							}
							return formatLines(filePath, rows);
						};

						// One output row's text: the trailing newline ripgrep sends is dropped
						// after the CR strip, not before, so a CRLF line does not keep a stray CR.
						const formatRowText = (lineText: string): string => {
							const sanitized = lineText.replace(/\r/g, "").replace(/\n$/, "");
							const { text, wasTruncated } = truncateLine(sanitized);
							if (wasTruncated) linesTruncated = true;
							return text;
						};

						let lastBlockFile: string | undefined;
						let lastBlockEnd = 0;

						/**
						 * Formats one contiguous run of match and context lines. `path:line: text`
						 * marks a match line, `path-line- text` a context line, and a blank separator
						 * keeps runs from different places apart.
						 */
						const formatLines = (
							filePath: string,
							rows: Array<{
								lineNumber: number;
								lineText: string;
								isMatch: boolean;
							}>,
						): string[] => {
							const relativePath = formatPath(filePath);
							// Separate from the previous block unless the two are adjacent in one file.
							if (
								printedLines.length > 0 &&
								(filePath !== lastBlockFile || rows[0]!.lineNumber > lastBlockEnd + 1)
							) {
								printedLines.push("--");
							}
							const block: string[] = [];
							for (const row of rows) {
								const text = formatRowText(row.lineText);
								block.push(
									`${relativePath}${row.isMatch ? ":" : "-"}${row.lineNumber}${row.isMatch ? ":" : "-"} ${text}`,
								);
							}
							printedLines.push(...block);
							for (const line of block) {
								if (MATCH_LINE.test(line)) lineDisplay.set(line, relativePath);
							}
							lastBlockFile = filePath;
							lastBlockEnd = rows[rows.length - 1]!.lineNumber;
							return block;
						};

						/**
						 * Prints the run collected so far, one block per file. The pending match stays
						 * aside because the next event may turn it into a third member of the run.
						 */
						const flushBlock = (): void => {
							const grouped = new Map<
								string,
								Array<{
									lineNumber: number;
									lineText: string;
									isMatch: boolean;
								}>
							>();
							for (const row of blockRows) {
								const rows = grouped.get(row.filePath) ?? [];
								rows.push({
									lineNumber: row.lineNumber,
									lineText: row.lineText,
									isMatch: row.isMatch,
								});
								grouped.set(row.filePath, rows);
							}
							for (const [filePath, rows] of grouped) formatLines(filePath, rows);
							blockRows.length = 0;
							pendingMatch = undefined;
						};

						/**
						 * Records one match against the limit, the per-file budget and the
						 * stopping condition. Shared by the ripgrep stream and the walker so both
						 * report the same notices. Returns false once no further match is wanted.
						 */
						const recordMatch = (
							filePath: string,
							lineNumber: number,
							lineText?: string,
							onLimit?: () => void,
						): boolean => {
							if (matchLimitReached) return false;
							const seenInFile = fileMatchCounts.get(filePath) ?? 0;
							if (seenInFile >= perFileLimit) {
								overflow.set(filePath, (overflow.get(filePath) ?? 0) + 1);
								return true;
							}
							fileMatchCounts.set(filePath, seenInFile + 1);
							matchCount++;
							// Counted here rather than where the line is printed: the notice compares it
							// against the total, so leaving it behind would name a file that printed every
							// match it had.
							keptByFile.set(filePath, (keptByFile.get(filePath) ?? 0) + 1);
							matches.push({ filePath, lineNumber, lineText });
							if (matchCount >= effectiveLimit) {
								matchLimitReached = true;
								// Stopping here means every file further along the walk was
								// never searched, which is not the same as "no matches there".
								onLimit?.();
								return false;
							}
							return true;
						};

						const runFallback = async (): Promise<void> => {
							const patternMatcher = compilePattern(pattern, {
								ignoreCase,
								literal,
							});
							const fileFilter = glob ? compilePathGlob(glob) : null;
							if (isDirectory) {
								await walkFiles(searchPath, {
									signal,
									visit: async (filePath) => {
										if (fileFilter && !fileFilter(relativeToRoot(searchPath, filePath))) return true;
										const lines = await getFileLines(filePath);
										for (let index = 0; index < lines.length; index++) {
											patternMatcher.lastIndex = 0;
											if (!patternMatcher.test(lines[index])) continue;
											if (!recordMatch(filePath, index + 1)) return false;
										}
										return true;
									},
								});
							} else {
								// A single-file search keeps ripgrep's behaviour: the glob filters the
								// File's own name, and it still has to match.
								const fileName = path.basename(searchPath);
								if (!fileFilter || fileFilter(fileName)) {
									const lines = await getFileLines(searchPath);
									for (let index = 0; index < lines.length; index++) {
										patternMatcher.lastIndex = 0;
										if (!patternMatcher.test(lines[index])) continue;
										if (!recordMatch(searchPath, index + 1)) break;
									}
								}
							}
						};

						/** Formats the collected matches and resolves. The search is over by now. */
						const finish = async (errorText?: string): Promise<void> => {
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (errorText !== undefined) {
								settle(() => reject(new Error(errorText)));
								return;
							}
							if (matchCount === 0) {
								// A bare "No matches found" also hides the case where every match
								// was cut by the per-file budget: there is plenty to report.
								const omitted = [...overflow.values()].reduce((sum, n) => sum + n, 0);
								const text =
									omitted === 0
										? "No matches found"
										: `No matches shown, but ${omitted} match(es) exceeded the ${perFileLimit}-match per-file budget. Use path= to search one file at a time`;
								const noMatchDetails: GrepToolDetails = {};
								if (fallback) noMatchDetails.fallback = true;
								if (omitted > 0) {
									noMatchDetails.trimmedFiles = [...overflow].map(([file, n]) => ({
										file: formatPath(file),
										shown: 0,
										omitted: n,
									}));
								}
								settle(() =>
									resolve({
										content: [
											{
												type: "text",
												text: fallback ? `${text}\n\n[${FALLBACK_NOTICE}]` : text,
											},
										],
										details: Object.keys(noMatchDetails).length > 0 ? noMatchDetails : undefined,
									}),
								);
								return;
							}

							// Matches the walker collected, formatted now so custom readFile() backends
							// can be async. ripgrep already printed its own lines as the stream arrived,
							// so only the walker's matches are left to format here.
							if (rgPath === undefined) {
								for (const match of matches) await formatBlock(match.filePath, match.lineNumber);
							}

							const rawOutput = printedLines.length > 0 ? printedLines.join("\n") : outputLines.join("\n");
							// Apply byte truncation. There is no line limit here because the match limit already capped rows.
							const truncation = truncateHead(rawOutput, {
								maxLines: Number.MAX_SAFE_INTEGER,
							});
							let output = truncation.content;
							// What actually made it into the output, for the notices that report drops.
							const linesKept = truncation.truncated ? truncation.content.split("\n") : rawOutput.split("\n");
							const matchesKept = linesKept.filter((line) => MATCH_LINE.test(line)).length;
							const details: GrepToolDetails = {};
							// Build actionable notices for truncation and match limits. Every notice
							// names what was dropped and where: "100 matches limit reached" on its own
							// reads as "this is all there is", and the model stops looking.
							const notices: string[] = [];
							const trimmedFiles: GrepTrimmedFile[] = [];
							const filesSearched = fileMatchCounts.size;
							if (fallback) {
								notices.push(FALLBACK_NOTICE);
								details.fallback = true;
							}
							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached after ${filesSearched} file${filesSearched === 1 ? "" : "s"}. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}
							if (stoppedEarly) {
								notices.push(
									"Search stopped early, so files later in the walk were not searched at all. Narrow with path= or glob= to cover them",
								);
								details.stoppedEarly = true;
							}
							if (truncation.truncated) {
								// The cap cut rows out of the joined output. How many matches are
								// still visible is counted on the surviving rows, not derived from
								// line totals, because context lines inflate those.
								notices.push(
									`${formatSize(DEFAULT_MAX_BYTES)} limit reached; ${matchCount - matchesKept} of ${matchCount} matches dropped. Narrow with path= or glob=`,
								);
								details.truncation = truncation;
							}
							// Matches the model can still see in each file: every accepted match when
							// nothing was cut, and the surviving rows per file otherwise. A fresh map,
							// because the accepted counts are what the truncated path re-counts.
							const visibleByFile = new Map<string, number>(keptByFile);
							if (truncation.truncated) {
								visibleByFile.clear();
								const labelToFile = new Map(
									[...fileMatchCounts].map(([filePath]) => [formatPath(filePath), filePath]),
								);
								for (const line of linesKept) {
									if (!MATCH_LINE.test(line)) continue;
									const filePath = labelToFile.get(lineDisplay.get(line) ?? "");
									if (filePath) visibleByFile.set(filePath, (visibleByFile.get(filePath) ?? 0) + 1);
								}
							}
							// Files that lost matches: the per-file budget first, then byte truncation.
							const omittedByFile = new Map<string, number>(overflow);
							if (truncation.truncated) {
								for (const [filePath, shown] of fileMatchCounts) {
									const lost = shown - (visibleByFile.get(filePath) ?? 0);
									if (lost > 0) omittedByFile.set(filePath, (omittedByFile.get(filePath) ?? 0) + lost);
								}
							}
							for (const [filePath, omitted] of omittedByFile) {
								if (omitted <= 0) continue;
								trimmedFiles.push({
									file: formatPath(filePath),
									shown: visibleByFile.get(filePath) ?? 0,
									omitted,
								});
							}
							trimmedFiles.sort((a, b) => b.omitted - a.omitted);
							if (trimmedFiles.length > 0) {
								const named = trimmedFiles
									.slice(0, TRIMMED_FILES_NAMED)
									.map((entry) => `${entry.file} (${entry.shown} of ${entry.shown + entry.omitted})`);
								const rest = trimmedFiles.length - named.length;
								notices.push(
									`Some files have more matches than shown: ${named.join(", ")}${rest > 0 ? `, and ${rest} more file${rest === 1 ? "" : "s"}` : ""}. Use path= to search one file at a time`,
								);
								details.trimmedFiles = trimmedFiles;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						};

						if (!child) {
							// No ripgrep: walk in process. Errors surface through `finish`'s
							// reject path so both branches share one exit.
							try {
								await runFallback();
							} catch (error) {
								settle(() => reject(error instanceof Error ? error : new Error(String(error))));
								return;
							}
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							await finish();
							return;
						}

						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});
						rl?.on("line", (line) => {
							if (!line.trim()) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							const isMatch = event.type === "match";
							if (!isMatch && event.type !== "context") return;
							const filePath = event.data?.path?.text;
							const lineNumber = event.data?.line_number;
							if (!filePath || typeof lineNumber !== "number") return;
							const rawText = event.data?.lines?.text;
							const lineText = typeof rawText === "string" ? rawText : "";
							if (!limitHit) {
								if (!isMatch) {
									if (pendingMatch !== undefined) {
										// Context for the pending match: the run continues.
										blockRows.push({ ...pendingMatch, isMatch: true });
										blockRows.push({
											filePath,
											lineNumber,
											lineText,
											isMatch: false,
										});
										pendingMatch = undefined;
										return;
									}
									if (blockRows.length > 0 && blockRows[0]!.filePath !== filePath) {
										// A file nobody matched in: nothing to attach its lines to.
										blockRows.length = 0;
										return;
									}
									// Leading context of the next match in the same file.
									blockRows.push({
										filePath,
										lineNumber,
										lineText,
										isMatch: false,
									});
									return;
								}
								const accepted = recordMatch(filePath, lineNumber, lineText, () => {
									limitHit = true;
									trailingFile = filePath;
									trailingContextEnd = lineNumber + contextValue;
								});
								if (!accepted) {
									// The limit cut this match: its leading context was already collected, and
									// printing both stops the run without losing what led up to it.
									blockRows.push({
										filePath,
										lineNumber,
										lineText,
										isMatch: true,
									});
									flushBlock();
									stopChild(true);
									return;
								}
								if (pendingMatch !== undefined) {
									blockRows.push({ ...pendingMatch, isMatch: true });
									pendingMatch = undefined;
								}
								if (contextValue === 0) {
									blockRows.push({
										filePath,
										lineNumber,
										lineText,
										isMatch: true,
									});
									flushBlock();
									return;
								}
								// Held: the next event is either its context, continuing this run, or the
								// start of the next run, in which case it is printed first.
								pendingMatch = { filePath, lineNumber, lineText };
								return;
							}
							// Only the last allowed match keeps its trailing context; a match inside that
							// window is shown as a context line, and one outside proves the limit cut
							// results off, so the walk stops instead of scanning every remaining file.
							if (filePath === trailingFile && lineNumber <= trailingContextEnd) {
								if (!isMatch)
									blockRows.push({
										filePath,
										lineNumber,
										lineText,
										isMatch: false,
									});
								return;
							}
							if (isMatch && filePath !== trailingFile) {
								stoppedEarly = true;
								stopChild(true);
							}
						});
						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", async (code) => {
							cleanup();
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								await finish(stderr.trim() || `ripgrep exited with code ${code}`);
								return;
							}
							// A run still open when the stream ends is complete: nothing follows it.
							if (pendingMatch !== undefined) {
								blockRows.push({ ...pendingMatch, isMatch: true });
								pendingMatch = undefined;
							}
							if (blockRows.length > 0) flushBlock();
							await finish();
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		...grepRenderers,
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
