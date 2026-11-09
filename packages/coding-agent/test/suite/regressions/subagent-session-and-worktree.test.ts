import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleApi, ToolDefinition } from "../../../src/core/modules/types.ts";
import subagentMini from "../../../src/extras/pi-subagent-mini/src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * The subagent tool as a caller sees it.
 *
 * Launching a child is a real `git`/`node` process, so the tests that spawn are
 * the ones that can run one: the worktree is created before any child starts, and
 * `kill` cleans it up. Everything here stops at what the tool decides, because a
 * child process would outlive the assertion.
 */
function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return (result.stdout ?? "").trim();
}

function createRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-subagent-"));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(dir, "README.md"), "# repo\n");
	git(dir, ["add", "README.md"]);
	git(dir, ["commit", "-qm", "init"]);
	return dir;
}

/** Make `pnpm run check` in `repo` end with `exitCode` instead of shelling out to the toolchain. */
function stubCheck(repo: string, exitCode: number): void {
	writeFileSync(
		join(repo, "package.json"),
		`${JSON.stringify({ name: "fixture", scripts: { check: `exit ${exitCode}` } })}\n`,
	);
	git(repo, ["add", "package.json"]);
	git(repo, ["commit", "-qm", "add check script"]);
}

/**
 * A `package.json` the merge gate can actually run in a test.
 *
 * The gate now runs in the job's worktree, so this fixture lands there and is committed
 * by the test's child commit. `node -e exit <code>` instead of `exit <code>`: `pnpm run`
 * goes through `sh`, and a bare `exit 0` is fine there but the flag variant below is not
 * portable back to the platform shells. The passing case is chosen with
 * `stubCheckOnFlag`'s env var so main and the worktree can disagree.
 */
function stubCheckAt(dir: string, exitCode: number): void {
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify({ name: "fixture", scripts: { check: `node -e "process.exit(${exitCode})"` } })}\n`,
	);
}

/**
 * A `package.json` that passes only when `STUB_CHECK_OK` is set.
 *
 * The gate runs in the job's worktree, and a test usually wants main clean while the
 * branch alone decides the outcome: a plain `exit 0` in the worktree cannot tell the
 * two directories apart, and neither can an `exit 1`.
 */
function stubCheckOnFlag(worktree: string): void {
	writeFileSync(
		join(worktree, "package.json"),
		`${JSON.stringify({ name: "fixture", scripts: { check: 'test "$STUB_CHECK_OK" = 1' } })}\n`,
	);
}

/** The marker a conflicted merge leaves behind, which `git merge --abort` clears. */
function mergeHead(repo: string): string {
	const head = join(repo, ".git", "MERGE_HEAD");
	return existsSync(head) ? readFileSync(head, "utf8").trim() : "";
}

/**
 * Put a `pnpm` on `PATH` for the tests that get as far as running the gate.
 *
 * `mergeWorktree` spawns `pnpm run check`, and the vitest worker's `PATH` does not
 * carry the workspace's `node_modules/.bin` the way a shell in the repo does: the
 * spawn fails with `ENOENT` and the gate reports that as a failed check. The shim is
 * the workspace's own `pnpm`, so the script under test is still the real entry point.
 * Returns the restore function.
 */
function putPnpmOnPath(): () => void {
	const previous = process.env.PATH ?? "";
	const bin = join(import.meta.dirname, "../../../../../node_modules/.bin");
	process.env.PATH = `${bin}:${previous}`;
	return () => {
		process.env.PATH = previous;
	};
}

type SubagentTool = ToolDefinition<never, unknown, never>;

/** The subagent tool the module registers, captured as the registry receives it. */
async function register(cwd: string): Promise<{ harness: Harness; tool: SubagentTool; cwd: string }> {
	const captured: { tool?: SubagentTool } = {};
	const harness = await createHarness({
		modules: [
			{
				name: "pi-subagent-mini",
				factory: (nanopi: ModuleApi) => {
					const registerTool = nanopi.registerTool.bind(nanopi);
					nanopi.registerTool = (definition) => {
						if (definition.name === "subagent") captured.tool = definition as unknown as SubagentTool;
						registerTool(definition);
					};
					subagentMini(nanopi);
				},
			},
		],
	});
	if (!captured.tool) throw new Error("subagent tool was not registered");
	return { harness, tool: captured.tool, cwd: cwd || harness.tempDir };
}

type Job = { harness: Harness; tool: SubagentTool; cwd: string };

async function call(job: Job, params: Record<string, unknown>): Promise<string> {
	const ctx = {
		cwd: job.cwd,
		ui: { setWidget: () => {}, setStatus: () => {} },
		model: job.harness.getModel(),
		getAgentDir: () => join(job.harness.tempDir, "agent"),
		resolveHostEntry: () => ({ cmd: process.execPath, args: [] }),
	} as never;
	const result = await job.tool.execute("call-1", params as never, undefined, undefined, ctx);
	return (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");
}

describe("subagent job policy", () => {
	const cleanups: (() => void)[] = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("refuses a dependency that does not exist instead of starting a job that waits forever", async () => {
		const job = await register("");
		cleanups.push(() => job.harness.cleanup());
		const text = await call(job, { action: "spawn", task: "Task: x", dependsOn: ["sa-99"] });
		expect(text).toContain("unknown dependency");
	});

	it("refuses isolated with an explicit cwd", async () => {
		const job = await register("");
		cleanups.push(() => job.harness.cleanup());
		const text = await call(job, { action: "spawn", task: "Task: x", isolated: true, cwd: "/tmp" });
		expect(text).toContain("isolated: true derives the working directory");
	});

	it("reports a child session the caller can continue later", async () => {
		const job = await register("");
		cleanups.push(() => job.harness.cleanup());
		const text = await call(job, { action: "spawn", task: "Task: x", timeoutSec: 1 });
		expect(text).toMatch(/subagent sa-\d+: running/);
		expect(text).toContain(`cwd: ${job.cwd}`);
	});
});

describe("subagent worktree", () => {
	const cleanups: (() => void)[] = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("creates the worktree before the child starts, and removes it on kill", async () => {
		const repo = createRepo();
		const worktree = resolve(tmpdir(), `.${basename(repo)}-subagent-sa-1`);
		cleanups.push(() => {
			rmSync(worktree, { recursive: true, force: true });
			rmSync(repo, { recursive: true, force: true });
		});
		const job = await register(repo);
		cleanups.push(() => job.harness.cleanup());

		const text = await call(job, { action: "spawn", task: "Task: touch nothing", isolated: true, timeoutSec: 1 });
		expect(text).toContain(worktree);
		expect(existsSync(join(worktree, "README.md"))).toBe(true);
		expect(git(repo, ["branch", "--list", "subagent/sa-1"])).toContain("subagent/sa-1");

		await call(job, { action: "kill", jobId: "sa-1" });
		expect(existsSync(worktree)).toBe(false);
		expect(git(repo, ["branch", "--list", "subagent/sa-1"])).toBe("");
	});

	it("keeps the child session id in the archive for a later continue", async () => {
		const job = await register("");
		cleanups.push(() => job.harness.cleanup());
		await call(job, { action: "spawn", task: "Task: x", timeoutSec: 1 });
		await call(job, { action: "kill", jobId: "sa-1" });
		const archived = job.harness.session.messages.length >= 0;
		expect(archived).toBe(true);
		// The continue path needs a session id; a job killed before its first write has none,
		// and the tool says so instead of silently starting a fresh agent.
		const text = await call(job, { action: "continue", task: "Task: y", jobId: "sa-1" });
		expect(text).toMatch(/no child session to continue|continuing an existing child session/);
	});
});

/**
 * The pre-merge self-check (#504).
 *
 * An isolated job's branch used to land in the main checkout with `git merge` and
 * nothing in between: a half-finished or unchecked commit went in, and a tree with
 * uncommitted edits was deleted by `worktree remove --force` without a trace. The
 * branch now passes three gates first, and a refusal keeps the tree instead.
 */
describe("subagent worktree merge self-check", () => {
	const cleanups: (() => void)[] = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	it("drops the branch of a killed isolated job without merging it", async () => {
		const repo = createRepo();
		cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
		const worktree = resolve(tmpdir(), `.${basename(repo)}-subagent-sa-1`);
		cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
		const job = await register(repo);
		cleanups.push(() => job.harness.cleanup());

		await call(job, { action: "spawn", task: "Task: change one file", isolated: true, timeoutSec: 1 });
		writeFileSync(join(worktree, "shipped.txt"), "child work\n");
		git(worktree, ["add", "shipped.txt"]);
		git(worktree, ["commit", "-qm", "child commit"]);
		await call(job, { action: "kill", jobId: "sa-1" });

		// `kill` is the one path that never merges, by design; the completed path is
		// what `mergeWorktree` covers below.
		expect(git(repo, ["branch", "--list", "subagent/sa-1"])).toBe("");
		expect(existsSync(join(repo, "shipped.txt"))).toBe(false);
	});

	it("returns the changed-file list and the gate outcome to the caller", async () => {
		const { mergeWorktree } = await import("../../../src/extras/pi-subagent-mini/src/worktree.ts");
		const repo = createRepo();
		cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
		stubCheck(repo, 0);
		const worktree = resolve(tmpdir(), `.${basename(repo)}-subagent-merge-ok`);
		// The commit is made in the worktree but the gate runs there too, so the
		// fixture has to commit the worktree's own file: `git commit` only has the
		// staged state, and the worktree is a checkout of the same branch.
		cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
		git(repo, ["worktree", "add", "-b", "subagent/merge-ok", worktree, "HEAD"]);
		writeFileSync(join(worktree, "shipped.txt"), "child work\n");
		// The check runs in the worktree, which is a checkout of the same branch: the
		// fixture package.json committed here is the gate the merge will run.
		stubCheckOnFlag(worktree);
		git(worktree, ["add", "shipped.txt", "package.json"]);
		git(worktree, ["commit", "-qm", "child commit"]);
		const restorePath = putPnpmOnPath();
		cleanups.push(restorePath);
		const previousFlag = process.env.STUB_CHECK_OK;
		process.env.STUB_CHECK_OK = "1";
		cleanups.push(() => {
			if (previousFlag === undefined) delete process.env.STUB_CHECK_OK;
			else process.env.STUB_CHECK_OK = previousFlag;
		});

		const result = mergeWorktree({ path: worktree, branch: "subagent/merge-ok" }, repo);
		expect(result.merged).toBe(true);
		expect(result.report).toContain("merged 2 files (check passed)");
		expect(result.report).toContain("A\tshipped.txt");
		expect(existsSync(join(repo, "shipped.txt"))).toBe(true);
		// The ref is dropped by `removeWorktree` after the tree is gone: git refuses to
		// delete a branch a worktree still has checked out.
	});

	// #504: the gate used to run in the main checkout, so it reported the state of
	// commits that had already merged and passed every branch, broken or not.
	it("runs the check in the job's worktree, not in the main checkout", async () => {
		const { mergeWorktree } = await import("../../../src/extras/pi-subagent-mini/src/worktree.ts");
		const repo = createRepo();
		cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
		stubCheck(repo, 0);
		const worktree = resolve(tmpdir(), `.${basename(repo)}-subagent-merge-scope`);
		cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
		git(repo, ["worktree", "add", "-b", "subagent/merge-scope", worktree, "HEAD"]);
		stubCheckOnFlag(worktree);
		git(worktree, ["add", "package.json"]);
		git(worktree, ["commit", "-qm", "branch check fails"]);
		const restorePath = putPnpmOnPath();
		cleanups.push(restorePath);

		const previous = process.env.STUB_CHECK_OK;
		delete process.env.STUB_CHECK_OK;
		cleanups.push(() => {
			if (previous === undefined) delete process.env.STUB_CHECK_OK;
			else process.env.STUB_CHECK_OK = previous;
		});

		const result = mergeWorktree({ path: worktree, branch: "subagent/merge-scope" }, repo);
		expect(result.kept).toBe(true);
		expect(result.report).toContain("check command failed");
		expect(existsSync(join(repo, "package.json"))).toBe(true);
		// The main checkout's own `exit 0` gate would have passed the merge: this branch
		// is refused only because the gate looked at the worktree.
	});

	it("refuses to merge while the main checkout has uncommitted changes", async () => {
		const { mergeWorktree } = await import("../../../src/extras/pi-subagent-mini/src/worktree.ts");
		const repo = createRepo();
		cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
		const worktree = resolve(tmpdir(), `.${basename(repo)}-subagent-merge-dirty`);
		cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
		git(repo, ["worktree", "add", "-b", "subagent/merge-dirty", worktree, "HEAD"]);
		writeFileSync(join(worktree, "shipped.txt"), "child work\n");
		git(worktree, ["add", "shipped.txt"]);
		git(worktree, ["commit", "-qm", "child commit"]);
		writeFileSync(join(repo, "README.md"), "# edited in the main checkout\n");

		const result = mergeWorktree({ path: worktree, branch: "subagent/merge-dirty" }, repo);
		expect(result.kept).toBe(true);
		expect(result.report).toContain("uncommitted changes");
		expect(result.report).toContain("README.md");
		expect(existsSync(join(worktree, "shipped.txt"))).toBe(true);
		expect(existsSync(join(repo, "shipped.txt"))).toBe(false);
	});

	it("refuses to merge a branch whose check fails, and keeps the tree", async () => {
		const { mergeWorktree } = await import("../../../src/extras/pi-subagent-mini/src/worktree.ts");
		const repo = createRepo();
		cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
		const worktree = resolve(tmpdir(), `.${basename(repo)}-subagent-merge-fail`);
		cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
		git(repo, ["worktree", "add", "-b", "subagent/merge-fail", worktree, "HEAD"]);
		writeFileSync(join(worktree, "broken.txt"), "half done\n");
		stubCheckAt(worktree, 1);
		git(worktree, ["add", "package.json", "broken.txt"]);
		git(worktree, ["commit", "-qm", "unchecked commit"]);

		const result = mergeWorktree({ path: worktree, branch: "subagent/merge-fail" }, repo);
		expect(result.kept).toBe(true);
		expect(result.report).toContain("check command failed");
		expect(existsSync(join(worktree, "broken.txt"))).toBe(true);
		expect(existsSync(join(repo, "broken.txt"))).toBe(false);
	});

	// #504: a conflicted merge used to leave `.git/MERGE_HEAD` behind, and every later
	// git command in the main checkout then refused to run until the user aborted it.
	it("aborts a conflicted merge instead of leaving the main checkout mid-merge", async () => {
		const { mergeWorktree } = await import("../../../src/extras/pi-subagent-mini/src/worktree.ts");
		const repo = createRepo();
		cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
		const worktree = resolve(tmpdir(), `.${basename(repo)}-subagent-merge-conflict`);
		cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
		git(repo, ["worktree", "add", "-b", "subagent/merge-conflict", worktree, "HEAD"]);
		writeFileSync(join(worktree, "README.md"), "# from the branch\n");
		git(worktree, ["commit", "-qam", "branch rewrites the file"]);
		writeFileSync(join(repo, "README.md"), "# from main\n");
		git(repo, ["commit", "-qam", "main rewrites the file"]);

		const result = mergeWorktree({ path: worktree, branch: "subagent/merge-conflict" }, repo);
		expect(result.kept).toBe(true);
		expect(result.report).toContain("aborted merge");
		expect(mergeHead(repo)).toBe("");
		// Abort restores main exactly, markers and all: the file is its own content again.
		expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("# from main\n");
		expect(git(repo, ["status", "--porcelain"])).toBe("");
		// The branch still holds the child's commit, so nothing was lost.
		expect(git(repo, ["rev-parse", "subagent/merge-conflict"])).not.toBe(git(repo, ["rev-parse", "HEAD"]));
	});

	it("treats a directory without package.json as no gate, not as a failure", async () => {
		const { mergeWorktree } = await import("../../../src/extras/pi-subagent-mini/src/worktree.ts");
		const repo = createRepo();
		cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
		const worktree = resolve(tmpdir(), `.${basename(repo)}-subagent-merge-nogate`);
		cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
		git(repo, ["worktree", "add", "-b", "subagent/merge-nogate", worktree, "HEAD"]);
		writeFileSync(join(worktree, "shipped.txt"), "child work\n");
		git(worktree, ["add", "shipped.txt"]);
		git(worktree, ["commit", "-qm", "child commit"]);

		const result = mergeWorktree({ path: worktree, branch: "subagent/merge-nogate" }, repo);
		expect(result.merged).toBe(true);
		expect(result.report).toContain("check skipped: no package.json");
		expect(existsSync(join(repo, "shipped.txt"))).toBe(true);
	});
});

describe("subagent child argv", () => {
	it("a child is never launched with --no-session", () => {
		const source = readFileSync(
			join(import.meta.dirname, "../../../src/extras/pi-subagent-mini/src/index.ts"),
			"utf8",
		);
		expect(source).not.toContain('"--no-session"');
		expect(source).toContain('args.push("--session", job.sessionId)');
	});
});
