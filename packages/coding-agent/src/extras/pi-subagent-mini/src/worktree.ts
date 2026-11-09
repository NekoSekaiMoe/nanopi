import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The pre-merge self-check for an isolated job's branch.
 *
 * `git merge` on its own accepts the whole branch: a half-finished commit goes into
 * the main checkout unread, and the parent never learns which files arrived. This
 * module is the gate in front of that merge — clean main checkout, the repository's
 * own `check` command, and a changed-file list in the report. A refusal keeps the
 * tree, so the work is still there for the parent to inspect; deleting it is what
 * silently discarded a child's output before.
 */

/** The `git worktree add` result for an isolated job. */
export interface Worktree {
	path: string;
	branch: string;
	/** What happened to the branch: `true` landed it, `false` dropped it. Unset while undecided. */
	merged?: boolean;
	/** Neither merged nor dropped: the tree and the branch are still there. */
	kept?: boolean;
	/** The changed-file list on a merge, or why it did not land. */
	report?: string;
}

/** Wall clock for `pnpm run check`; a check that hangs must not hold the job open forever. */
const CHECK_TIMEOUT_MS = 600_000;
/** Tail of the check output kept in the report; the failing assertion is at the end. */
const CHECK_OUTPUT_CHARS = 2000;
/** Uncommitted-path lines kept from `git status --porcelain`; the rest is noise. */
const DIRTY_LIST_LINES = 20;

/** Run `git` in `cwd`. Returns trimmed stdout; throws with stderr on a non-zero exit. */
function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
	}
	return (result.stdout ?? "").trim();
}

/** Committed changes in `branch`, as `git diff --name-status` reports them. */
function changedFiles(top: string, branch: string): string[] {
	const diff = git(top, ["diff", "--name-status", "HEAD", branch]);
	if (!diff) return [];
	return diff
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * The repository's own gate, run in the job's worktree before its branch lands.
 *
 * `top` is the worktree, not the main checkout: the question is whether the child's
 * code passes, and the main checkout by construction holds only commits that already
 * merged. Running it in main would pass the gate for every branch, including a broken one.
 * `skipped` is not `passed`: a directory without `package.json` has no gate to run,
 * and inventing one would make isolation unusable outside a JS repository.
 */
export function runCheck(top: string): { status: "passed" | "failed" | "skipped"; output?: string } {
	if (!existsSync(path.join(top, "package.json"))) return { status: "skipped" };
	const result = spawnSync("pnpm", ["run", "check"], { cwd: top, encoding: "utf8", timeout: CHECK_TIMEOUT_MS });
	if (result.error) return { status: "failed", output: result.error.message };
	if (result.status === 0) return { status: "passed" };
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	return { status: "failed", output: output.slice(-CHECK_OUTPUT_CHARS) || `exit ${result.status}` };
}

/**
 * Merge `worktree.branch` into the checkout at `baseCwd`, unless a gate refuses.
 *
 * Mutates `worktree` the same way the tool records it: `merged` on success, `kept`
 * plus a `report` on refusal. The branch ref is left alone — git refuses to delete a
 * branch that the worktree still has checked out, so dropping it is the caller's job
 * after the tree is gone.
 */
export function mergeWorktree(worktree: Worktree, baseCwd: string): Worktree {
	const refuse = (reason: string): Worktree => {
		worktree.merged = false;
		worktree.kept = true;
		worktree.report = `${reason}\nThe branch ${worktree.branch} is unchanged; inspect it, or drop it with \`git branch -D ${worktree.branch}\`.`;
		return worktree;
	};
	let top: string;
	try {
		top = git(baseCwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		return refuse(`${baseCwd} is not a git checkout, so the branch has nowhere to land.`);
	}
	const files = changedFiles(top, worktree.branch);
	if (files.length === 0) {
		// Merging nothing would print "Already up to date" and still leave a ref to drop.
		worktree.merged = true;
		worktree.report = "no commits of its own; nothing to merge";
		return worktree;
	}
	let dirty: string;
	try {
		dirty = git(top, ["status", "--porcelain"]);
	} catch (error) {
		return refuse(error instanceof Error ? error.message : String(error));
	}
	if (dirty) {
		const head = dirty.split("\n").slice(0, DIRTY_LIST_LINES).join("\n");
		return refuse(`the main checkout has uncommitted changes, so a merge would mix them in:\n${head}`);
	}
	const check = runCheck(worktree.path);
	if (check.status === "failed") {
		return refuse(`the repository's check command failed on the job's worktree:\n${check.output}`);
	}
	try {
		git(top, ["merge", "--no-edit", worktree.branch]);
	} catch (error) {
		// A conflict leaves the checkout in `.git/MERGE_HEAD` with conflict markers in the
		// files, which every later git command would read as "a merge is in progress".
		// Abort it here rather than handing the parent a tree it has to repair by hand;
		// the branch is untouched by `merge --abort`, so the work still exists.
		let aborted = false;
		try {
			git(top, ["merge", "--abort"]);
			aborted = true;
		} catch {
			// Abort is best effort: the merge error is the reason worth reporting, and a
			// failed abort must not replace it.
		}
		const reason = error instanceof Error ? error.message : String(error);
		const recovery = aborted
			? "The aborted merge left the main checkout as it was."
			: "The main checkout may still be mid-merge; run `git merge --abort` there.";
		return refuse(`${reason}\n${recovery}`);
	}
	worktree.merged = true;
	const gate = check.status === "skipped" ? "check skipped: no package.json" : "check passed";
	const line = `merged ${files.length} file${files.length === 1 ? "" : "s"} (${gate}):`;
	worktree.report = [line, ...files].join("\n");
	return worktree;
}
