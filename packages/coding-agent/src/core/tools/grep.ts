import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@nanopi/pi-agent-core";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ModuleContext, ToolDefinition } from "../modules/types.ts";
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
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export const grepToolSystemPromptContribution = {
	snippet: "Search file contents for patterns (respects .gitignore)",
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
		description: `Search file contents; returns matching lines with paths and line numbers. Respects .gitignore. Truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB; long lines to ${GREP_MAX_LINE_LENGTH} chars.`,
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
						if (!rgPath) {
							settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", ctx?.cwd || cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
								} catch {
									lines = [];
								}
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						// --no-config: the tool contract (literal, glob, limit, ...) must not depend on
						// ambient user config like RIPGREP_CONFIG_PATH.
						const args: string[] = ["--no-config", "--json", "--line-number", "--color=never", "--hidden"];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob);
						args.push("--", pattern, searchPath);

						const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						let stoppedEarly = false;
						const outputLines: string[] = [];
						// Per-file budget: without it one chatty file spends the whole global
						// match limit and the handful of files ripgrep had already scanned are
						// all the model gets, with no sign that the rest were never searched.
						const perFileLimit = Math.min(PER_FILE_LIMIT, effectiveLimit);
						const fileMatchCounts = new Map<string, number>();
						// Output line -> the file it describes, so the notices can count what
						// survived byte truncation without re-parsing the formatted text.
						const lineDisplay = new Map<string, string>();
						// Lines each file actually contributed, context lines included; the
						// difference against fileMatchCounts is what byte truncation dropped.
						const printedByFile = new Map<string, number>();

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) return [`${relativePath}:${lineNumber}: (unable to read file)`];
							const block: string[] = [];
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(/\r/g, "");
								const isMatchLine = current === lineNumber;
								// Truncate long lines so grep output stays compact.
								const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
								if (wasTruncated) linesTruncated = true;
								if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
								else block.push(`${relativePath}-${current}- ${truncatedText}`);
							}
							return block;
						};

						// Collect matches during streaming, then format them after rg exits.
						const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
						// Matches ripgrep reported for a file that was already over its own
						// budget. Counted, never printed, so the notice can say how much was
						// dropped instead of silently losing it.
						const overflow = new Map<string, number>();
						rl.on("line", (line) => {
							if (!line.trim() || matchLimitReached) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (event.type === "match") {
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								const lineText = event.data?.lines?.text;
								if (!filePath || typeof lineNumber !== "number") return;
								const seenInFile = fileMatchCounts.get(filePath) ?? 0;
								if (seenInFile >= perFileLimit) {
									overflow.set(filePath, (overflow.get(filePath) ?? 0) + 1);
									return;
								}
								fileMatchCounts.set(filePath, seenInFile + 1);
								matchCount++;
								matches.push({ filePath, lineNumber, lineText });
								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									// Stopping here means every file further along the walk was
									// never searched, which is not the same as "no matches there".
									stoppedEarly = true;
									stopChild(true);
								}
							}
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", async (code) => {
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
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
								settle(() =>
									resolve({
										content: [{ type: "text", text }],
										details:
											omitted === 0
												? undefined
												: {
														trimmedFiles: [...overflow].map(([file, n]) => ({
															file: formatPath(file),
															shown: 0,
															omitted: n,
														})),
													},
									}),
								);
								return;
							}

							// Format matches after streaming finishes so custom readFile() backends can be async.
							for (const match of matches) {
								if (contextValue === 0 && match.lineText !== undefined) {
									const relativePath = formatPath(match.filePath);
									const sanitized = match.lineText
										.replace(/\r\n/g, "\n")
										.replace(/\r/g, "")
										.replace(/\n$/, "");
									const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
									if (wasTruncated) linesTruncated = true;
									const row = `${relativePath}:${match.lineNumber}: ${truncatedText}`;
									outputLines.push(row);
									lineDisplay.set(row, relativePath);
									printedByFile.set(match.filePath, (printedByFile.get(match.filePath) ?? 0) + 1);
								} else {
									const block = await formatBlock(match.filePath, match.lineNumber);
									outputLines.push(...block);
									for (const row of block) {
										if (MATCH_LINE.test(row)) lineDisplay.set(row, formatPath(match.filePath));
									}
									printedByFile.set(match.filePath, (printedByFile.get(match.filePath) ?? 0) + 1);
								}
							}

							const rawOutput = outputLines.join("\n");
							// Apply byte truncation. There is no line limit here because the match limit already capped rows.
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let output = truncation.content;
							// What actually made it into the output, for the notices that report drops.
							const linesKept = truncation.truncated ? truncation.content.split("\n") : outputLines;
							const matchesKept = linesKept.filter((line) => MATCH_LINE.test(line)).length;
							const details: GrepToolDetails = {};
							// Build actionable notices for truncation and match limits. Every notice
							// names what was dropped and where: "100 matches limit reached" on its own
							// reads as "this is all there is", and the model stops looking.
							const notices: string[] = [];
							const trimmedFiles: GrepTrimmedFile[] = [];
							const filesSearched = fileMatchCounts.size;
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
							// Matches the model can still see in each file: everything printed when
							// nothing was cut, and the surviving rows per file otherwise.
							const keptByFile = truncation.truncated ? new Map<string, number>() : printedByFile;
							if (truncation.truncated) {
								const labelToFile = new Map(
									[...fileMatchCounts].map(([filePath]) => [formatPath(filePath), filePath]),
								);
								for (const line of linesKept) {
									if (!MATCH_LINE.test(line)) continue;
									const filePath = labelToFile.get(lineDisplay.get(line) ?? "");
									if (filePath) keptByFile.set(filePath, (keptByFile.get(filePath) ?? 0) + 1);
								}
							}
							// Files that lost matches: the per-file budget first, then byte truncation.
							const omittedByFile = new Map<string, number>(overflow);
							if (truncation.truncated) {
								for (const [filePath, shown] of fileMatchCounts) {
									const lost = shown - (keptByFile.get(filePath) ?? 0);
									if (lost > 0) omittedByFile.set(filePath, (omittedByFile.get(filePath) ?? 0) + lost);
								}
							}
							for (const [filePath, omitted] of omittedByFile) {
								if (omitted <= 0) continue;
								trimmedFiles.push({
									file: formatPath(filePath),
									shown: keptByFile.get(filePath) ?? 0,
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
