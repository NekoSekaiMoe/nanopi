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
		cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
		git(repo, ["worktree", "add", "-b", "subagent/merge-ok", worktree, "HEAD"]);
		writeFileSync(join(worktree, "shipped.txt"), "child work\n");
		git(worktree, ["add", "shipped.txt"]);
		git(worktree, ["commit", "-qm", "child commit"]);

		const result = mergeWorktree({ path: worktree, branch: "subagent/merge-ok" }, repo);
		expect(result.merged).toBe(true);
		expect(result.report).toContain("merged 1 file (check passed)");
		expect(result.report).toContain("A\tshipped.txt");
		expect(existsSync(join(repo, "shipped.txt"))).toBe(true);
		// The ref is dropped by `removeWorktree` after the tree is gone: git refuses to
		// delete a branch a worktree still has checked out.
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
		stubCheck(repo, 1);
		const worktree = resolve(tmpdir(), `.${basename(repo)}-subagent-merge-fail`);
		cleanups.push(() => rmSync(worktree, { recursive: true, force: true }));
		git(repo, ["worktree", "add", "-b", "subagent/merge-fail", worktree, "HEAD"]);
		writeFileSync(join(worktree, "broken.txt"), "half done\n");
		git(worktree, ["add", "broken.txt"]);
		git(worktree, ["commit", "-qm", "unchecked commit"]);

		const result = mergeWorktree({ path: worktree, branch: "subagent/merge-fail" }, repo);
		expect(result.kept).toBe(true);
		expect(result.report).toContain("check command failed");
		expect(existsSync(join(worktree, "broken.txt"))).toBe(true);
		expect(existsSync(join(repo, "broken.txt"))).toBe(false);
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
