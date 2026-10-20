import { createInterface } from "node:readline";
import type { AgentTool } from "@nanopi/pi-agent-core";
import { spawn, spawnSync } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ModuleContext, ToolDefinition } from "../modules/types.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { findRenderers } from "./renderers/find.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

/** Relativize a find result against the search root and normalize it to posix separators. */
export function relativizeFindResultPath(
	resultPath: string,
	searchPath: string,
	pathModule: path.PlatformPath = path,
): string {
	const hadTrailingSeparator =
		resultPath.endsWith(pathModule.sep) || (pathModule.sep === "\\" && resultPath.endsWith("/"));
	const relativePath = pathModule.isAbsolute(resultPath) ? pathModule.relative(searchPath, resultPath) : resultPath;
	const posixPath = relativePath.split(pathModule.sep).join("/");
	return hadTrailingSeparator && !posixPath.endsWith("/") ? `${posixPath}/` : posixPath;
}

const findSchema = Type.Object({
	pattern: Type.String({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
});

/** fd gained `--no-require-git` in 9.0; 8.x rejects the flag. */
function supportsNoRequireGit(fdPath: string): boolean {
	const result = spawnSync(fdPath, ["--help"], { encoding: "utf8" });
	return `${result.stdout ?? ""}${result.stderr ?? ""}`.includes("--no-require-git");
}

/** fd 8.x rejects the whole invocation with this text instead of ignoring one unknown option. */
function isUnknownFdOptionError(stderr: string): boolean {
	return stderr.includes("which wasn't expected") || stderr.includes("isn't valid in this context");
}

function formatFindResult(lines: string[], searchPath: string, effectiveLimit: number) {
	if (lines.length === 0) {
		return { content: [{ type: "text" as const, text: "No files found matching pattern" }], details: undefined };
	}
	// Relativize paths against the search root for stable output.
	const relativized = lines.map((line) => relativizeFindResultPath(line, searchPath));
	const resultLimitReached = relativized.length >= effectiveLimit;
	const truncation = truncateHead(relativized.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	let resultOutput = truncation.content;
	const details: FindToolDetails = {};
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(`${effectiveLimit} results limit reached`);
		details.resultLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.length > 0) {
		resultOutput += `\n\n[${notices.join(". ")}]`;
	}
	return {
		content: [{ type: "text" as const, text: resultOutput }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

export const findToolSystemPromptContribution = {
	snippet: "Find files by glob pattern (respects .gitignore)",
	guidelines: [],
} as const;

export type FindToolInput = Static<typeof findSchema>;

const DEFAULT_LIMIT = 1000;

export interface FindToolDetails {
	truncation?: TruncationResult;
	resultLimitReached?: number;
}

/**
 * Pluggable operations for the find tool.
 * Override these to delegate file search to remote systems (for example SSH).
 */
export interface FindOperations {
	/** Check if path exists */
	exists: (absolutePath: string) => Promise<boolean> | boolean;
	/** Find files matching glob pattern. Returns relative or absolute paths. */
	glob: (pattern: string, cwd: string, options: { ignore: string[]; limit: number }) => Promise<string[]> | string[];
}

const defaultFindOperations: FindOperations = {
	exists: pathExists,
	// This is a placeholder. Actual fd execution happens in execute() when no custom glob is provided.
	glob: () => [],
};

export interface FindToolOptions {
	/** Custom operations for find. Default: local filesystem plus fd */
	operations?: FindOperations;
}

export function createFindToolDefinition(
	cwd: string,
	options?: FindToolOptions,
): ToolDefinition<typeof findSchema, FindToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "find",
		label: "find",
		description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		promptSnippet: findToolSystemPromptContribution.snippet,
		parameters: findSchema,
		async execute(
			_toolCallId,
			{ pattern, path: searchDir, limit }: { pattern: string; path?: string; limit?: number },
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
				let stopChild: (() => void) | undefined;
				const settle = (fn: () => void) => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					stopChild = undefined;
					fn();
				};
				const onAbort = () => {
					stopChild?.();
					settle(() => reject(new Error("Operation aborted")));
				};
				signal?.addEventListener("abort", onAbort, { once: true });

				(async () => {
					try {
						const searchPath = resolveToCwd(searchDir || ".", ctx?.cwd || cwd);
						const effectiveLimit = limit ?? DEFAULT_LIMIT;
						const ops = customOps ?? defaultFindOperations;

						// If custom operations provide glob(), use that instead of fd.
						if (customOps?.glob) {
							if (!(await ops.exists(searchPath))) {
								settle(() => reject(new Error(`Path not found: ${searchPath}`)));
								return;
							}
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							const results = await ops.glob(pattern, searchPath, {
								ignore: ["**/node_modules/**", "**/.git/**"],
								limit: effectiveLimit,
							});
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (results.length === 0) {
								settle(() =>
									resolve({
										content: [{ type: "text", text: "No files found matching pattern" }],
										details: undefined,
									}),
								);
								return;
							}

							settle(() => resolve(formatFindResult(results, searchPath, effectiveLimit)));
							return;
						}

						// Default implementation uses fd.
						const fdPath = await ensureTool("fd");
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						if (!fdPath) {
							settle(() => reject(new Error("fd is not available and could not be downloaded")));
							return;
						}

						const baseArgs: string[] = ["--glob", "--color=never", "--hidden"];

						// fd normally ignores .gitignore outside git repos, so keep --no-require-git
						// there. Inside repos, use fd's default git-aware behavior so parent
						// .gitignore rules stop at nested repo boundaries:
						// https://github.com/NekoSekaiMoe/nanopi/issues/5960
						let insideGitRepo = false;
						for (let current = searchPath; ; ) {
							if (await pathExists(path.join(current, ".git"))) {
								insideGitRepo = true;
								break;
							}
							const parent = path.dirname(current);
							if (parent === current) break;
							current = parent;
						}
						const noRequireGit = !insideGitRepo && supportsNoRequireGit(fdPath);
						baseArgs.push("--max-results", String(effectiveLimit));

						// fd --glob matches against the basename unless --full-path is set; in --full-path
						// mode it matches against the absolute candidate path, so a path-containing
						// pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
						let effectivePattern = pattern;
						if (pattern.includes("/")) {
							baseArgs.push("--full-path");
							if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
								effectivePattern = `**/${pattern}`;
							}
							// fd matches full paths using native separators on Windows.
							if (process.platform === "win32")
								effectivePattern = effectivePattern.replaceAll("/", String.raw`[/\\]`);
						}
						baseArgs.push("--", effectivePattern, searchPath);

						const runFd = (args: string[]): Promise<{ code: number | null; stderr: string; lines: string[] }> =>
							new Promise((resolveFd, rejectFd) => {
								const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
								const rl = createInterface({ input: child.stdout });
								let stderr = "";
								const lines: string[] = [];
								stopChild = () => {
									if (!child.killed) {
										child.kill();
									}
								};
								child.stderr?.on("data", (chunk) => {
									stderr += chunk.toString();
								});
								rl.on("line", (line) => {
									lines.push(line);
								});
								child.on("error", (error) => {
									rl.close();
									rejectFd(new Error(`Failed to run fd: ${error.message}`));
								});
								child.on("close", (code) => {
									rl.close();
									resolveFd({ code, stderr, lines });
								});
							});

						const withNoRequireGit = noRequireGit
							? [baseArgs[0], "--no-require-git", ...baseArgs.slice(1)]
							: undefined;
						let result = await runFd(withNoRequireGit ?? baseArgs);
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						// `--no-require-git` exists from fd 9.0. A binary that still rejects it falls back
						// to fd's default behaviour, which only honours .gitignore inside a git repo:
						// hierarchical rules still work there, so retrying is better than failing.
						if (withNoRequireGit && result.code !== 0 && isUnknownFdOptionError(result.stderr)) {
							result = await runFd(baseArgs);
							if (signal?.aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
						}
						const { code, stderr, lines } = result;
						const output = lines.join("\n");
						if (code !== 0 && !output) {
							settle(() => reject(new Error(stderr.trim() || `fd exited with code ${code}`)));
							return;
						}

						const paths: string[] = [];
						for (const rawLine of lines) {
							const line = rawLine.replace(/\r$/, "").trim();
							if (!line) continue;
							paths.push(line);
						}
						settle(() => resolve(formatFindResult(paths, searchPath, effectiveLimit)));
					} catch (e) {
						if (signal?.aborted) {
							settle(() => reject(new Error("Operation aborted")));
							return;
						}
						const error = e instanceof Error ? e : new Error(String(e));
						settle(() => reject(error));
					}
				})();
			});
		},
		...findRenderers,
	};
}

export function createFindTool(cwd: string, options?: FindToolOptions): AgentTool<typeof findSchema> {
	return wrapToolDefinition(createFindToolDefinition(cwd, options));
}
