/**
 * pi-git-tools — read-only git tool that does not depend on GitHub.
 *
 * `git` covers status, diff, log and current branch behind one action field.
 * `action=diff` can ask a subagent to abridge a large patch; the compiler in
 * `pi-meat` guarantees the abridged diff is a projection of the original, not
 * invented prose.
 */

import { spawnSync } from "node:child_process";
import type { ModuleToolContext, ModuleToolsSurface } from "../../../core/modules/types.ts";
import { Type } from "typebox";

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

function text(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
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
const DIFF_TARGETS: readonly DiffTarget[] = ["staged", "unstaged", "all", "branch"];

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
				"status (default): working tree and branch. diff: patch, target=staged|unstaged|all|branch, base for branch, max_bytes, abridge. log: recent commits, limit. branch: current branch.",
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
		Type.Integer({ description: "diff: patch byte cap (default 50000).", minimum: 1000, maximum: 1_000_000 }),
	),
	abridge: Type.Optional(Type.Boolean({ description: 'diff: ask a subagent to abridge a large patch (default: false).' })),
	limit: Type.Optional(Type.Integer({ description: "log: commit count (default 10, max 100).", minimum: 1, maximum: 100 })),
});

interface GitParams {
	action?: "status" | "diff" | "log" | "branch";
	cwd?: string;
	max_lines?: number;
	target?: DiffTarget;
	base?: string;
	max_bytes?: number;
	abridge?: boolean;
	limit?: number;
}

/**
 * Parse `subagent spawn` output for its job id. The tool's own reply is the
 * only source; there is no second channel to guess an id from.
 */
function jobIdOf(reply: string): string | undefined {
	return /(sa-\d+)/.exec(reply)?.[1];
}

async function abridgedDiff(
	ctx: ModuleToolContext,
	params: { target: DiffTarget; cwd: string; base: string; maxBytes: number },
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	if (!ctx.tools.some((tool) => tool.name === "subagent") || signal?.aborted) return undefined;
	const brief = [
		"GOAL: Reduce this git diff to the lines that carry the change, keeping every kept line verbatim.",
		"CONTEXT: The diff is pasted below with 1-based line numbers (N|). Use read/grep if you need to judge importance.",
		`Target: ${params.target}, base: ${params.base}, repo: ${params.cwd}.`,
		"EXPECTED OUTPUT: call the `meat` tool with the numbered diff. It validates and compiles the edit plan and returns the reading diff. Report that diff verbatim.",
		"STOP RULES: never paraphrase or invent diff lines; if `meat` is unavailable, report the failure.",
		"",
	].join("\n");
	const spawned = await ctx.executeTool(
		"subagent",
		{
			action: "spawn",
			task: brief,
			description: `meat diff ${params.target}`,
			tools: "meat,read,grep",
			timeoutSec: 180,
		},
		{ signal },
	);
	const job = jobIdOf(
		(spawned.result.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n"),
	);
	if (!job || spawned.isError) return undefined;
	const waited = await ctx.executeTool("subagent", { action: "wait", jobId: job, waitSec: 180 }, { signal });
	const report = (waited.result.content ?? [])
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n");
	if (waited.isError || /still running|wait timed out/.test(report)) return undefined;
	// The subagent's report is a `Scope:`/Result envelope; the reading diff is
	// inside a fenced block produced by the meat tool.
	const fence = /```(?:diff)?\n([\s\S]*?)\n```/.exec(report);
	return (fence?.[1] ?? report).trim() || undefined;
}

export default function gitTools(pi: ModuleToolsSurface): void {
	pi.registerTool({
		name: "git",
		label: "git",
		description:
			"Read-only git inspection in one tool. action=status (default), diff (staged/unstaged/all/branch, optional subagent abridging), log, or branch. All outputs are capped.",
		promptSnippet: "Inspect git status, diff, log or the current branch",
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
					const maxBytes = params.max_bytes ?? 50_000;
					const diff = rawDiff(target, cwd, base, maxBytes);
					if (params.abridge !== true) return text(diff);
					const abridged = await abridgedDiff(ctx, { target, cwd, base, maxBytes }, signal);
					return text(abridged ?? diff);
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

export { runGit, gitStatus, rawDiff, currentBranch, isGitRepo };
