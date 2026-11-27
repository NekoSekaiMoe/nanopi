/**
 * pi-git-tools — read-only git tool that does not depend on GitHub.
 *
 * `git` covers status, diff, log and current branch behind one action field.
 * `action=diff` can return the raw patch or a faithful reading diff built by
 * the compiler in ./vendor/compiler.ts: a subagent submits line coordinates
 * and every kept line is emitted verbatim, so the result is a projection of
 * the original patch, not invented prose.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModuleToolContext, ModuleToolsSurface } from "../../../core/modules/types.ts";
import { Type } from "typebox";
import {
	compilePlan,
	manifestLine,
	numberDiff,
	type CompileResult,
	type Submission,
} from "./vendor/compiler.ts";
import { RUBRIC } from "./vendor/rubric.ts";

interface CmdResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

function runGit(args: string[], cwd: string): CmdResult {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
	});
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code;
		return {
			stdout: "",
			stderr: code === "ENOENT" ? "git: not found on PATH." : `git: failed to spawn: ${result.error.message}`,
			exitCode: code === "ENOENT" ? 127 : 1,
		};
	}
	if (result.signal) {
		return {
			stdout: result.stdout ?? "",
			stderr: `git: killed by ${result.signal} (30s timeout).`,
			exitCode: 124,
		};
	}
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", exitCode: result.status ?? 1 };
}

function isGitRepo(cwd: string): boolean {
	const r = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
	return r.exitCode === 0 && r.stdout.trim() === "true";
}

function findGitRoot(start: string): string | null {
	let dir = start;
	for (let i = 0; i < 64; i++) {
		if (existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function text(text: string, details: object = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function errorText(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: {}, isError: true as const };
}

function gitStatus(cwd: string, maxLines: number): string {
	if (!isGitRepo(cwd)) return "not inside a git repository";
	const result = runGit(["status", "--branch", "--porcelain"], cwd);
	if (result.exitCode !== 0) return result.stderr.trim() || `git status exited ${result.exitCode}`;
	const body = result.stdout.replace(/\n$/, "");
	if (!body) return "clean working tree, nothing to commit";
	const lines = body.split("\n");
	return lines.length <= maxLines
		? body
		: `${lines.slice(0, maxLines).join("\n")}\n... (+${lines.length - maxLines} more)`;
}

type DiffTarget = "staged" | "unstaged" | "all" | "branch";
type DiffMode = "raw" | "reading";
const DIFF_TARGETS: readonly DiffTarget[] = ["staged", "unstaged", "all", "branch"];
const DIFF_MODES: readonly DiffMode[] = ["raw", "reading"];
const STAT = ["--stat", "--patch"];

function diffArgs(target: DiffTarget, base: string): string[] {
	switch (target) {
		case "staged":
			return ["diff", "--cached"];
		case "all":
			return ["diff", "HEAD"];
		case "branch":
			return ["diff", `origin/${base}...HEAD`];
		default:
			return ["diff"];
	}
}

/**
 * Return a raw diff capped at `maxBytes` UTF-8 bytes, with a leading --stat.
 * The byte cap is on the patch only; --stat always fits in a few lines.
 */
function rawDiff(target: DiffTarget, cwd: string, base: string, maxBytes: number): string {
	if (!isGitRepo(cwd)) return "not inside a git repository";
	const args = diffArgs(target, base);
	const stat = runGit([...args, "--stat"], cwd);
	if (stat.exitCode !== 0) return stat.stderr.trim() || `git diff exited ${stat.exitCode}`;
	const patch = runGit(args, cwd);
	if (patch.exitCode !== 0) return patch.stderr.trim() || `git diff exited ${patch.exitCode}`;
	const bytes = Buffer.byteLength(patch.stdout, "utf8");
	if (bytes <= maxBytes) return patch.stdout || stat.stdout || "(no changes)";
	const truncated = Buffer.from(patch.stdout, "utf8").subarray(0, maxBytes).toString("utf8");
	return `${stat.stdout}\n--- patch truncated (${bytes} > ${maxBytes} bytes) ---\n${truncated}\n...`;
}

// --- faithful reading diff (formerly the `meat` tool) ----------------------

const MAX_LINES = 2000;
const MAX_BYTES = 80_000;
const MAX_CHUNKS = 32;
const MAX_TOTAL_BYTES = 4_000_000;
const COMPILER_REV = "2";

interface ReadingDetails {
	mode: DiffMode;
	target: DiffTarget;
	chunks: number;
	visibleChanged: number;
	totalChanged: number;
	folds: number;
	cached: boolean;
}

interface CachedResult extends CompileResult {
	cached?: boolean;
}

function extractDiffBody(stdout: string): string {
	const m = /^diff --git /m.exec(stdout);
	return m ? stdout.slice(m.index) : "";
}

function sizeOk(diff: string): boolean {
	const lines = diff.replace(/\n$/, "").split("\n").length;
	return lines <= MAX_LINES && Buffer.byteLength(diff, "utf8") <= MAX_BYTES;
}

/** Split at file, then hunk, boundaries; keep the file header on each piece. */
function splitForChunking(diff: string): string[] {
	const lines = diff.split("\n");
	const sections: string[][] = [];
	for (const line of lines) {
		if (line.startsWith("diff --git")) sections.push([line]);
		else (sections[sections.length - 1] ??= []).push(line);
	}
	const chunks: string[] = [];
	const flush = (piece: string[]) => {
		const t = piece.join("\n").replace(/\n$/, "");
		if (t) chunks.push(t);
	};
	for (const section of sections) {
		const text = section.join("\n");
		if (sizeOk(text)) {
			chunks.push(text.replace(/\n$/, ""));
			continue;
		}
		const firstHunk = section.findIndex((l) => l.startsWith("@@"));
		if (firstHunk <= 0) {
			chunks.push(text.replace(/\n$/, ""));
			continue;
		}
		const meta = section.slice(0, firstHunk);
		const hunks: string[][] = [];
		for (let i = firstHunk; i < section.length; i++) {
			if (section[i]!.startsWith("@@")) hunks.push([section[i]!]);
			else (hunks[hunks.length - 1] ??= []).push(section[i]!);
		}
		let piece = [...meta];
		for (const hunk of hunks) {
			const candidate = [...piece, ...hunk].join("\n");
			if (!sizeOk(candidate) && piece.length > meta.length) {
				flush(piece);
				piece = [...meta];
			}
			piece.push(...hunk);
		}
		flush(piece);
	}
	return chunks.slice(0, MAX_CHUNKS);
}

function mergeResults(parts: CompileResult[]): CompileResult {
	return {
		abridged: parts.map((p) => p.abridged).filter((a) => a !== "").join("\n"),
		summary: [...new Set(parts.map((p) => p.summary).filter((s) => s.trim() !== ""))].join("; ") || "(no summary)",
		visibleChanged: parts.reduce((a, p) => a + p.visibleChanged, 0),
		removedChanged: parts.reduce((a, p) => a + p.removedChanged, 0),
		foldedChanged: parts.reduce((a, p) => a + p.foldedChanged, 0),
		totalChanged: parts.reduce((a, p) => a + p.totalChanged, 0),
		totalLines: parts.reduce((a, p) => a + p.totalLines, 0),
		folds: parts.reduce((a, p) => a + p.folds, 0),
		markers: parts.reduce((a, p) => a + p.markers, 0),
		files: {
			kept: parts.reduce((a, p) => a + p.files.kept, 0),
			total: parts.reduce((a, p) => a + p.files.total, 0),
		},
		allElided: parts.every((p) => p.abridged === ""),
	};
}

function cacheDir(): string {
	return path.join(process.env.NANOPI_AGENT_DIR || path.join(os.homedir(), ".nanopi", "agent"), "cache", "pi-reading-diff");
}

function cacheKey(chunk: string): string {
	return createHash("sha256").update(`${COMPILER_REV}\0${chunk}`).digest("hex");
}

function readCache(key: string): CachedResult | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path.join(cacheDir(), `${key}.json`), "utf8"));
		if (
			parsed &&
			typeof parsed === "object" &&
			typeof (parsed as CompileResult).abridged === "string" &&
			typeof (parsed as CompileResult).summary === "string" &&
			typeof (parsed as CompileResult).totalChanged === "number"
		) {
			return parsed as CompileResult;
		}
	} catch {
		// Cache is best effort.
	}
	return undefined;
}

function writeCache(key: string, result: CompileResult): void {
	try {
		const dir = cacheDir();
		mkdirSync(dir, { recursive: true });
		const tmp = path.join(dir, `${key}.json.${process.pid}.tmp`);
		writeFileSync(tmp, JSON.stringify(result), "utf8");
		renameSync(tmp, path.join(dir, `${key}.json`));
	} catch {
		// Cache write failure must never break the tool.
	}
}

function fenceFor(body: string): string {
	let longest = 0;
	let run = 0;
	for (const ch of body) {
		if (ch === "`") {
			run++;
			longest = Math.max(longest, run);
		} else run = 0;
	}
	return "`".repeat(Math.max(3, longest + 1));
}

/** Parse `subagent spawn` output for its job id. */
function jobIdOf(reply: string): string | undefined {
	return /(sa-\d+)/.exec(reply)?.[1];
}

function reportText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

/** Ask a subagent to submit an edit plan for one numbered chunk, then compile it. */
async function abridgeChunk(
	ctx: ModuleToolContext,
	chunk: string,
	force: boolean,
	signal: AbortSignal | undefined,
): Promise<CachedResult> {
	const numbered = numberDiff(chunk);
	const lines = numbered.split("\n").length;
	const key = cacheKey(chunk);
	const cached = readCache(key);
	if (cached && !force) return { ...cached, cached: true };

	const brief = [
		"GOAL: Submit one edit plan that reduces a git diff to the lines a senior engineer must read.",
		`CONTEXT: ${RUBRIC}\n\nThe numbered diff (${lines} lines):\n${numbered}`,
		"EXPECTED OUTPUT: call the `submit_plan` tool exactly once with remove/fold/replace/summary, then reply with only the JSON you submitted: {\"remove\":[...],\"fold\":[...],\"replace\":[...],\"summary\":\"...\"}.",
		"STOP RULES: never write diff content yourself; keep uncertain lines; do not call submit twice.",
	].join("\n\n");

	const spawned = await ctx.executeTool(
		"subagent",
		{ action: "spawn", task: brief, description: "git diff reading", tools: "read,grep", timeoutSec: 180 },
		{ signal },
	);
	const spawnText = reportText(spawned.result);
	const job = jobIdOf(spawnText);
	if (spawned.isError || !job) throw new Error(`git: subagent failed to start: ${spawnText.slice(0, 300)}`);

	const waited = await ctx.executeTool("subagent", { action: "wait", jobId: job, waitSec: 180 }, { signal });
	const report = reportText(waited.result);
	if (waited.isError || /still running|wait timed out/.test(report)) {
		throw new Error(`git: subagent did not finish: ${report.slice(0, 300)}`);
	}

	const jsonMatches = report.match(/\{[^{}]*"summary"[^{}]*\}/g);
	const raw = jsonMatches?.[jsonMatches.length - 1];
	if (!raw) throw new Error("git: subagent did not report an edit plan.");
	let submission: Submission;
	try {
		const parsed: unknown = JSON.parse(raw);
		submission = {
			remove: Array.isArray((parsed as Submission).remove) ? (parsed as Submission).remove : [],
			fold: Array.isArray((parsed as Submission).fold) ? (parsed as Submission).fold : [],
			replace: Array.isArray((parsed as Submission).replace) ? (parsed as Submission).replace : [],
			summary: String((parsed as Submission).summary ?? ""),
		};
	} catch {
		throw new Error("git: subagent reported an unparseable edit plan.");
	}
	const result = compilePlan(chunk, submission);
	writeCache(key, result);
	return result;
}

async function readingDiff(
	target: DiffTarget,
	cwd: string,
	base: string,
	force: boolean,
	ctx: ModuleToolContext,
	signal: AbortSignal | undefined,
) {
	if (!ctx.tools.some((tool) => tool.name === "subagent")) {
		return errorText("git: reading diff requires the subagent tool; use mode=raw for a raw diff.");
	}
	const root = findGitRoot(cwd);
	if (!root) return errorText("git: not inside a git repository.");
	const proc = runGit([...diffArgs(target, base), ...STAT], root);
	if (proc.exitCode !== 0) return errorText(proc.stderr.trim() || `git diff exited ${proc.exitCode}`);
	const diff = extractDiffBody(proc.stdout);
	if (!diff.trim()) return text("(no changes)");
	if (Buffer.byteLength(diff, "utf8") > MAX_TOTAL_BYTES) {
		return errorText(`git: diff exceeds ${MAX_TOTAL_BYTES} bytes; narrow it with target and base.`);
	}
	const chunks = splitForChunking(diff);
	const results: CachedResult[] = [];
	for (const chunk of chunks) results.push(await abridgeChunk(ctx, chunk, force, signal));
	const compiled = mergeResults(results);
	const fence = fenceFor(compiled.abridged);
	const body = [`${fence}diff`, compiled.abridged, fence, "", manifestLine(compiled)].join("\n");
	const details: ReadingDetails = {
		mode: "reading",
		target,
		chunks: chunks.length,
		visibleChanged: compiled.visibleChanged,
		totalChanged: compiled.totalChanged,
		folds: compiled.folds,
		cached: results.some((r) => r.cached === true),
	};
	return text(body, details);
}

// --- log and branch --------------------------------------------------------

interface GitLogEntry {
	hash: string;
	isoDate: string;
	author: string;
	subject: string;
	body: string;
}

export function parseGitLog(stdout: string): GitLogEntry[] {
	return stdout
		.split("\u0000")
		.filter((rec) => rec !== "")
		.map((rec) => {
			const [hash, isoDate, author, subject, ...body] = rec.split("\u0001");
			return {
				hash: hash ?? "",
				isoDate: isoDate ?? "",
				author: author ?? "",
				subject: subject ?? "",
				body: body.join("\u0001").trim(),
			};
		});
}

function gitLog(limit: number, cwd: string): GitLogEntry[] {
	if (!isGitRepo(cwd)) return [];
	const fmt = "%H%x01%aI%x01%an%x01%s%x01%b%x00";
	const r = runGit(["log", `-n${Math.max(1, Math.min(limit, 100))}`, `--format=${fmt}`, "--"], cwd);
	return r.exitCode === 0 ? parseGitLog(r.stdout) : [];
}

function currentBranch(cwd: string): string {
	if (!isGitRepo(cwd)) return "";
	const r = runGit(["symbolic-ref", "--short", "HEAD"], cwd);
	if (r.exitCode === 0) return r.stdout.trim();
	const detached = runGit(["rev-parse", "--short", "HEAD"], cwd);
	return detached.exitCode === 0 ? `HEAD (detached at ${detached.stdout.trim()})` : "";
}

const cwdParam = Type.Optional(Type.String({ description: "Repository directory (default: session cwd)." }));

const gitParams = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("status"), Type.Literal("diff"), Type.Literal("log"), Type.Literal("branch")], {
			description:
				"status (default): working tree and branch. diff: patch, target=staged|unstaged|all|branch, base for branch, mode=raw|reading. log: recent commits, limit. branch: current branch.",
		}),
	),
	cwd: cwdParam,
	max_lines: Type.Optional(Type.Integer({ description: "status: max porcelain lines (default 200).", minimum: 1, maximum: 5000 })),
	target: Type.Optional(
		Type.Union(DIFF_TARGETS.map((t) => Type.Literal(t)), {
			description: 'diff: staged, unstaged (default), all, or branch (vs origin/<base>).',
		}),
	),
	base: Type.Optional(Type.String({ description: 'diff: base branch for target="branch" (default: main).' })),
	max_bytes: Type.Optional(
		Type.Integer({ description: "diff: patch byte cap for mode=raw (default 50000).", minimum: 1000, maximum: 1_000_000 }),
	),
	mode: Type.Optional(
		Type.Union(DIFF_MODES.map((m) => Type.Literal(m)), {
			description: 'diff: raw patch (default) or a faithful reading diff (mode=reading, needs subagent).',
		}),
	),
	force: Type.Optional(Type.Boolean({ description: "diff: re-run subagents even with a cache hit (mode=reading)." })),
	limit: Type.Optional(Type.Integer({ description: "log: commit count (default 10, max 100).", minimum: 1, maximum: 100 })),
});

interface GitParams {
	action?: "status" | "diff" | "log" | "branch";
	cwd?: string;
	max_lines?: number;
	target?: DiffTarget;
	base?: string;
	max_bytes?: number;
	mode?: DiffMode;
	force?: boolean;
	limit?: number;
}

export default function gitTools(pi: ModuleToolsSurface): void {
	pi.registerTool({
		name: "git",
		label: "git",
		description:
			"Read-only git inspection in one tool. action=status (default), diff (raw or faithful reading diff), log, or branch. All outputs are capped.",
		promptSnippet: "Inspect git status, diff, log or the current branch; mode=reading gives a condensed, faithful diff",
		annotations: { readOnlyHint: true },
		parameters: gitParams,
		async execute(_id, params: GitParams, signal, _onUpdate, ctx) {
			const cwd = params.cwd ?? ctx.cwd;
			switch (params.action ?? "status") {
				case "diff": {
					const target = DIFF_TARGETS.includes(params.target as DiffTarget)
						? (params.target as DiffTarget)
						: "unstaged";
					const base = params.base ?? "main";
					if (params.mode === "reading") {
						return readingDiff(target, cwd, base, params.force === true, ctx, signal);
					}
					const diff = rawDiff(target, cwd, base, params.max_bytes ?? 50_000);
					return text(diff, { mode: "raw", target });
				}
				case "log": {
					const entries = gitLog(params.limit ?? 10, cwd);
					if (entries.length === 0) return text("(no commits on the current branch)");
					return text(
						entries
							.map((e) => {
								const body = e.body ? `\n    ${e.body.replace(/\n/g, "\n    ")}` : "";
								return `${e.hash.slice(0, 7)} ${e.isoDate} ${e.author}: ${e.subject}${body}`;
							})
							.join("\n"),
					);
				}
				case "branch":
					return text(currentBranch(cwd) || "(not inside a git repository)");
				case "status":
					return text(gitStatus(cwd, params.max_lines ?? 200));
			}
		},
	});
}

export {
	runGit,
	gitStatus,
	rawDiff,
	currentBranch,
	isGitRepo,
	splitForChunking,
	sizeOk,
	mergeResults,
	extractDiffBody,
	findGitRoot,
};
