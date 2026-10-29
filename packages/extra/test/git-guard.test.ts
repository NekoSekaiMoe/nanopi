import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { analyzeGitInvocation, analyzeShellCommand, listWorktrees } from "../src/git-guard.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * Hermetic git: the vendored git config would filter the fresh repo's identity
 * away, and the host may have commit signing on, so both are set explicitly here.
 */
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_AUTHOR_NAME: "agent",
			GIT_AUTHOR_EMAIL: "agent@example.com",
			GIT_COMMITTER_NAME: "agent",
			GIT_COMMITTER_EMAIL: "agent@example.com",
		},
	}).trim();
}

/** A repository with one commit and one linked worktree, the layout subagents use. */
function repoWithWorktree(): { main: string; linked: string } {
	const main = tempDir("gitguard-");
	git(main, "init", "-q", "-b", "main");
	writeFileSync(join(main, "file.txt"), "one\n");
	git(main, "add", "file.txt");
	git(main, "commit", "-q", "-m", "one");
	const linked = join(tempDir("gitguard-wt-"), "linked");
	git(main, "worktree", "add", "-q", "-b", "subagent/sa-1", linked, "HEAD");
	return { main, linked };
}

describe("git guard: destructive commands", () => {
	test("hard reset, stash, clean -f, add -A and checkout . are hazards", () => {
		const cwd = tempDir("gitguard-plain-");
		for (const command of [
			"git reset --hard",
			"git reset --hard HEAD~1",
			"git stash",
			"git stash push -m wip",
			"git clean -fd",
			"git clean -fdx",
			"git add -A",
			"git add .",
			"git checkout .",
			"git restore .",
			"git commit --no-verify -m x",
			"git push --force origin main",
		]) {
			const verdict = analyzeShellCommand(command, cwd);
			if (!verdict.checked) throw new Error(`${command} was not analyzed`);
			expect(verdict.hit, command).toBeDefined();
		}
	});

	test("read-only and scoped forms pass", () => {
		const cwd = tempDir("gitguard-plain-");
		for (const command of [
			"git status",
			"git stash list",
			"git stash show -p",
			"git clean -n",
			"git add -u",
			"git add src/one.ts",
			"git checkout -b feat",
			"git checkout main",
			"git restore --staged one.ts",
			"git commit -m x",
			"git push origin main",
		]) {
			const verdict = analyzeShellCommand(command, cwd);
			if (!verdict.checked) throw new Error(`${command} was not analyzed`);
			expect(verdict.hit, command).toBeUndefined();
		}
	});

	// nanopi#376: the hazards below were reported as missed.
	test("an absolute or relative path to git still counts as git", () => {
		const cwd = tempDir("gitguard-plain-");
		for (const command of [
			"/usr/bin/git reset --hard",
			"./git stash",
			"command /usr/bin/git reset --hard",
			"sudo /usr/bin/git clean -fd",
		]) {
			const verdict = analyzeShellCommand(command, cwd);
			if (verdict.checked !== true) throw new Error(`${command} was not analyzed`);
			expect(verdict.hit, command).toBeDefined();
		}
	});

	test("checkout -f overwrites the working tree, with or without a pathspec", () => {
		const cwd = tempDir("gitguard-plain-");
		for (const command of ["git checkout -f", "git checkout -f HEAD", "git checkout --force main"]) {
			const verdict = analyzeShellCommand(command, cwd);
			if (verdict.checked !== true) throw new Error(`${command} was not analyzed`);
			expect(verdict.hit?.subcommand, command).toBe("checkout");
		}
		// A plain branch switch stays free.
		const switchBranch = analyzeShellCommand("git checkout main", cwd);
		if (!switchBranch.checked) throw new Error("not analyzed");
		expect(switchBranch.hit).toBeUndefined();
	});

	test("a reset that only moves the index still asks, dropping changes would not be recoverable from the index", () => {
		const cwd = tempDir("gitguard-plain-");
		const verdict = analyzeShellCommand("git reset", cwd);
		if (!verdict.checked) throw new Error("not analyzed");
		expect(verdict.hit?.subcommand).toBe("reset");
	});
});

describe("git guard: finding the command inside the line", () => {
	const cwd = tempDir("gitguard-plain-");

	test("cd, bash -c, substitutions and newlines are seen through", () => {
		for (const command of [
			"cd sub && git stash",
			"bash -c 'git reset --hard'",
			'sh -lc "git clean -fd"',
			"echo $(git stash)",
			"echo `git stash`",
			"git status\ngit stash",
			"sudo git stash",
			"GIT_TRACE=1 git stash",
			"(cd sub; git stash)",
		]) {
			const verdict = analyzeShellCommand(command, cwd);
			expect(verdict.checked, command).toBe(true);
			if (!verdict.checked) continue;
			expect(verdict.hit, command).toBeDefined();
		}
	});

	test("quoted operators and redirections do not create phantom commands", () => {
		const verdict = analyzeShellCommand("git log --format='%H;%s' > out.log && echo 'git stash'", cwd);
		if (!verdict.checked) throw new Error("not analyzed");
		expect(verdict.hit).toBeUndefined();
		expect(analyzeShellCommand("printf 'git stash\\n'", cwd)).toEqual({ checked: true });
	});

	test("a shell this analyzer cannot read gives no verdict instead of a guess", () => {
		expect(analyzeShellCommand("bash ./script.sh", cwd)).toEqual({ checked: false });
		expect(analyzeShellCommand("cd $DIR && git stash", cwd)).toEqual({ checked: false });
	});
});

describe("git guard: worktrees", () => {
	test("lists the linked worktree alongside the checkout it walks up from", () => {
		const { main, linked } = repoWithWorktree();
		const checkouts = listWorktrees(main);
		expect(checkouts).toHaveLength(2);
		expect(checkouts).toContain(main);
		expect(checkouts.some((entry) => entry.endsWith("linked"))).toBe(true);
		// From inside the linked worktree the answer is the same set.
		expect(listWorktrees(join(linked, ".")).sort()).toEqual(checkouts.sort());
	});

	test("a destructive command aimed at another checkout is isolation, not a hazard", () => {
		const { main, linked } = repoWithWorktree();
		const verdict = analyzeShellCommand(`git -C ${linked} reset --hard`, main);
		if (!verdict.checked) throw new Error("not analyzed");
		expect(verdict.hit).toBeUndefined();
		expect(verdict.isolated?.path).toContain("linked");
	});

	test("the same command in this checkout is a hazard even when another worktree exists", () => {
		const { main } = repoWithWorktree();
		const verdict = analyzeShellCommand("git reset --hard", main);
		if (!verdict.checked) throw new Error("not analyzed");
		expect(verdict.hit).toBeDefined();
		expect(listWorktrees(main)).toHaveLength(2);
	});

	test("worktree add reports the tree it creates", () => {
		const { main } = repoWithWorktree();
		const add = analyzeShellCommand("git worktree add -b feat ../feat HEAD", main);
		if (!add.checked) throw new Error("not analyzed");
		expect(add.hit).toBeUndefined();
		expect(add.isolated?.path).toContain("feat");
	});

	test("a cd into a worktree still has to be the same checkout to count as isolation", () => {
		// Only `git worktree add` and `git -C` are tied to a checkout on disk; a plain
		// `cd` is resolved by string, and guessing that the directory exists would be
		// the kind of silent miss this guard exists to prevent.
		const { main, linked } = repoWithWorktree();
		const inLinked = analyzeShellCommand(`cd ${linked} && git stash`, main);
		if (!inLinked.checked) throw new Error("not analyzed");
		expect(inLinked.hit).toBeDefined();
		const viaC = analyzeShellCommand(`git -C ${linked} stash`, main);
		if (!viaC.checked) throw new Error("not analyzed");
		expect(viaC.hit).toBeUndefined();
	});

	test("relative -C resolves against the directory the shell runs in", () => {
		const { main, linked } = repoWithWorktree();
		const verdict = analyzeGitInvocation(["git", "-C", linked, "clean", "-fd"], main);
		if (!verdict.checked) throw new Error("not analyzed");
		expect(verdict.hit).toBeUndefined();
	});
});
