/**
 * pi-meat — a tool that reads a git diff and returns a faithful reading diff.
 *
 * The model only selects line ranges to remove/fold and single-line spans to
 * elide. The deterministic compiler in ./compiler.ts renders every untouched
 * line verbatim, so the result is always a projection of the original diff.
 * The select step runs in a subagent: the numbered diff and the selection
 * conversation stay out of the main context.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModuleToolContext, ModuleToolsSurface } from "../../../core/modules/types.ts";
import { type Static, Type } from "typebox";
import { compilePlan, manifestLine, numberDiff, type CompileResult, type Submission } from "./compiler.ts";
import { RUBRIC } from "./rubric.ts";

const MAX_LINES = 2000;
const MAX_BYTES = 80_000;
const MAX_CHUNKS = 32;
const MAX_TOTAL_BYTES = 4_000_000;
const COMPILER_REV = "2";

const STAT = ["--stat", "--patch"];
const GIT_PREFIX: Record<string, string[]> = {
	working: ["diff", ...STAT],
	staged: ["diff", "--cached", ...STAT],
	all: ["diff", "HEAD", ...STAT],
	commit: ["show", "-m", "--first-parent", ...STAT],
	range: ["diff", ...STAT],
};

interface MeatDetails {
	mode: string;
	chunks: number;
	visibleChanged: number;
	totalChanged: number;
	folds: number;
	cached: boolean;
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

function extractDiffBody(stdout: string): string {
	const m = /^diff --git /m.exec(stdout);
	return m ? stdout.slice(m.index) : "";
}

function sizeOk(text: string): boolean {
	const lines = text.replace(/\n$/, "").split("\n").length;
	return lines <= MAX_LINES && Buffer.byteLength(text, "utf8") <= MAX_BYTES;
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
	return path.join(process.env.NANOPI_AGENT_DIR || path.join(os.homedir(), ".nanopi", "agent"), "cache", "pi-meat");
}

function cacheKey(chunk: string): string {
	return createHash("sha256").update(`${COMPILER_REV}\0${chunk}`).digest("hex");
}

interface CachedResult extends CompileResult {
	cached?: boolean;
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

/**
 * Ask a subagent to submit an edit plan for one numbered chunk, then compile
 * the plan here. The subagent returns JSON in its final report; a malformed
 * report fails the chunk rather than being passed off as a compiled diff.
 */
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
		{ action: "spawn", task: brief, description: "meat chunk", tools: "read,grep", timeoutSec: 180 },
		{ signal },
	);
	const spawnText = (spawned.result.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
	const job = /(sa-\d+)/.exec(spawnText)?.[1];
	if (spawned.isError || !job) throw new Error(`meat: subagent failed to start: ${spawnText.slice(0, 300)}`);

	const waited = await ctx.executeTool("subagent", { action: "wait", jobId: job, waitSec: 180 }, { signal });
	const report = (waited.result.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
	if (waited.isError || /still running|wait timed out/.test(report)) {
		throw new Error(`meat: subagent did not finish: ${report.slice(0, 300)}`);
	}

	// The subagent must report the plan it submitted; parse the last JSON object.
	const jsonMatches = report.match(/\{[^{}]*"summary"[^{}]*\}/g);
	const raw = jsonMatches?.[jsonMatches.length - 1];
	if (!raw) throw new Error("meat: subagent did not report an edit plan.");
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
		throw new Error("meat: subagent reported an unparseable edit plan.");
	}
	const result = compilePlan(chunk, submission);
	writeCache(key, result);
	return result;
}

const params = Type.Object({
	mode: Type.Optional(
		Type.Union(
			[
				Type.Literal("working"),
				Type.Literal("staged"),
				Type.Literal("all"),
				Type.Literal("commit"),
				Type.Literal("range"),
			],
			{ description: "Which diff to read (default: working)." },
		),
	),
	ref: Type.Optional(Type.String({ description: "Commit or range for mode=commit/range." })),
	path: Type.Optional(Type.String({ description: "Limit mode=range to one path." })),
	cwd: Type.Optional(Type.String({ description: "Repository directory (default: session cwd)." })),
	force: Type.Optional(Type.Boolean({ description: "Re-run subagents even with a cache hit." })),
});

export default function meat(pi: ModuleToolsSurface): void {
	pi.registerTool({
		name: "meat",
		label: "meat: reading diff",
		description:
			"Read a git diff as a faithful reading diff: noise and repetition are removed by a subagent, but every kept line is verbatim from the original. Use it instead of a raw diff when a change spans many files or hundreds of lines.",
		promptSnippet: "Read a condensed, faithful git diff",
		annotations: { readOnlyHint: true },
		parameters: params,
		async execute(_id, p: Static<typeof params>, signal, _onUpdate, ctx: ModuleToolContext) {
			if (!ctx.tools.some((tool) => tool.name === "subagent")) {
				return {
					content: [{ type: "text" as const, text: "meat: requires the subagent tool; use git action=diff for a raw diff." }],
					details: {},
					isError: true,
				};
			}
			const mode = p.mode ?? "working";
			const cwd = p.cwd ?? ctx.cwd;
			const root = findGitRoot(cwd);
			if (!root) {
				return { content: [{ type: "text" as const, text: "meat: not inside a git repository." }], details: {}, isError: true };
			}
			const prefix = [...GIT_PREFIX[mode]!];
			if (mode === "commit" && p.ref) prefix.push(p.ref);
			if (mode === "range" && p.ref) prefix.push(p.ref);
			if (mode === "range" && p.path) prefix.push("--", p.path);
			const proc = spawnGit(prefix, root);
			if (proc.exitCode !== 0) {
				return {
					content: [{ type: "text" as const, text: proc.stderr.trim() || `git exited ${proc.exitCode}` }],
					details: {},
					isError: true,
				};
			}
			const diff = extractDiffBody(proc.stdout);
			if (!diff.trim()) {
				return { content: [{ type: "text" as const, text: "(no changes)" }], details: {} };
			}
			if (Buffer.byteLength(diff, "utf8") > MAX_TOTAL_BYTES) {
				return {
					content: [{ type: "text" as const, text: `meat: diff exceeds ${MAX_TOTAL_BYTES} bytes; narrow it with mode=range and ref/path.` }],
					details: {},
					isError: true,
				};
			}
			const chunks = splitForChunking(diff);
			const results: CachedResult[] = [];
			for (const chunk of chunks) {
				results.push(await abridgeChunk(ctx, chunk, p.force === true, signal));
			}
			const compiled = mergeResults(results);
			const fence = fenceFor(compiled.abridged);
			const body = [
				`${fence}diff`,
				compiled.abridged,
				fence,
				"",
				manifestLine(compiled),
			].join("\n");
			const details: MeatDetails = {
				mode,
				chunks: chunks.length,
				visibleChanged: compiled.visibleChanged,
				totalChanged: compiled.totalChanged,
				folds: compiled.folds,
				cached: results.some((r) => (r as CachedResult).cached === true),
			};
			return { content: [{ type: "text" as const, text: body }], details };
		},
	});
}

/** Bounded, synchronous git invocation with a closed stdin. */
function spawnGit(args: string[], cwd: string): { stdout: string; stderr: string; exitCode: number } {
	const r = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 30_000,
	});
	return {
		stdout: r.stdout ?? "",
		stderr: r.stderr ?? "",
		exitCode: r.error ? 127 : r.signal ? 124 : r.status ?? 1,
	};
}

export { splitForChunking, sizeOk, mergeResults, extractDiffBody, findGitRoot };
