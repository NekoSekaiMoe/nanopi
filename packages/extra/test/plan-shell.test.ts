import { describe, expect, test } from "vitest";
import { analyzeCommandForPlan, firstShellWord, tokenizeSimpleCommand } from "../src/plan-shell.ts";

describe("analyzeCommandForPlan", () => {
	test("allows the reading commands with arguments", () => {
		expect(analyzeCommandForPlan("ls -la /tmp")).toEqual({ allowed: true, firstCommand: "ls" });
		expect(analyzeCommandForPlan("pwd")).toEqual({ allowed: true, firstCommand: "pwd" });
		expect(analyzeCommandForPlan("find . -name '*.ts' -type f")).toEqual({ allowed: true, firstCommand: "find" });
		expect(analyzeCommandForPlan("cat package.json").allowed).toBe(true);
		expect(analyzeCommandForPlan("grep -rn foo src").allowed).toBe(true);
		expect(analyzeCommandForPlan("rg --files").allowed).toBe(true);
		expect(analyzeCommandForPlan("git status --short").allowed).toBe(true);
		expect(analyzeCommandForPlan("git -C packages/extra log --oneline -5").allowed).toBe(true);
		expect(analyzeCommandForPlan("gh pr view 622 --json title").allowed).toBe(true);
		expect(analyzeCommandForPlan("gh api repos/x/y/pulls/1").allowed).toBe(true);
	});

	test("allows quoted metacharacters as literals", () => {
		expect(analyzeCommandForPlan("find . -name 'a;b.ts'").allowed).toBe(true);
		expect(analyzeCommandForPlan('find . -name "a|b.ts"').allowed).toBe(true);
		expect(analyzeCommandForPlan("ls '#note'").allowed).toBe(true);
	});

	test("allows trailing comments", () => {
		expect(analyzeCommandForPlan("ls -la # list everything").allowed).toBe(true);
	});

	test("rejects commands outside the reading list", () => {
		const result = analyzeCommandForPlan("rm -rf /");
		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("read-only commands");
		expect(analyzeCommandForPlan("sed -i s/a/b/ f").allowed).toBe(false);
		expect(analyzeCommandForPlan("npm install").allowed).toBe(false);
		expect(analyzeCommandForPlan("sh -c 'ls'").allowed).toBe(false);
		expect(analyzeCommandForPlan("/bin/ls").allowed).toBe(false);
	});

	test("rejects git subcommands that write", () => {
		expect(analyzeCommandForPlan("git checkout main").allowed).toBe(false);
		expect(analyzeCommandForPlan("git commit -m x").allowed).toBe(false);
		// `git branch` without a list flag creates the branch it names.
		expect(analyzeCommandForPlan("git branch new-name").allowed).toBe(false);
		expect(analyzeCommandForPlan("git -C . stash").allowed).toBe(false);
	});

	test("rejects gh calls that write", () => {
		expect(analyzeCommandForPlan("gh pr create --title x").allowed).toBe(false);
		expect(analyzeCommandForPlan("gh pr comment 1 --body hi").allowed).toBe(false);
		expect(analyzeCommandForPlan("gh api -X POST repos/x/y").allowed).toBe(false);
		// GET through the method flag is still a read.
		expect(analyzeCommandForPlan("gh api --method GET repos/x/y/pulls").allowed).toBe(true);
	});

	test("rejects command separators", () => {
		expect(analyzeCommandForPlan("ls; pwd").allowed).toBe(false);
		expect(analyzeCommandForPlan("ls && pwd").allowed).toBe(false);
		expect(analyzeCommandForPlan("ls || pwd").allowed).toBe(false);
		expect(analyzeCommandForPlan("ls & pwd").allowed).toBe(false);
	});

	test("rejects pipes and redirections", () => {
		expect(analyzeCommandForPlan("ls | grep foo").allowed).toBe(false);
		expect(analyzeCommandForPlan("ls > out.txt").allowed).toBe(false);
		expect(analyzeCommandForPlan("ls >> out.txt").allowed).toBe(false);
		expect(analyzeCommandForPlan("pwd < in.txt").allowed).toBe(false);
		expect(analyzeCommandForPlan("ls 2>&1").allowed).toBe(false);
	});

	test("rejects command substitution, including inside double quotes", () => {
		expect(analyzeCommandForPlan("ls $(pwd)").allowed).toBe(false);
		expect(analyzeCommandForPlan("ls `pwd`").allowed).toBe(false);
		expect(analyzeCommandForPlan('find . -name "$(rm -rf /)"').allowed).toBe(false);
		expect(analyzeCommandForPlan('find . -name "`rm -rf /`"').allowed).toBe(false);
		// Single quotes are literal: safe.
		expect(analyzeCommandForPlan("find . -name '$(pwd)'").allowed).toBe(true);
	});

	test("rejects subshells and multi-line input", () => {
		expect(analyzeCommandForPlan("(ls)").allowed).toBe(false);
		expect(analyzeCommandForPlan("ls\npwd").allowed).toBe(false);
	});

	test("rejects find predicates that write or execute", () => {
		for (const predicate of ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0"]) {
			const result = analyzeCommandForPlan(`find . ${predicate} rm`);
			expect(result.allowed, predicate).toBe(false);
			expect(result.reason, predicate).toContain("read-only");
		}
		expect(analyzeCommandForPlan("find . -name '*.ts' -print").allowed).toBe(true);
	});

	test("rejects empty and unterminated input", () => {
		expect(analyzeCommandForPlan("").allowed).toBe(false);
		expect(analyzeCommandForPlan("   ").allowed).toBe(false);
		expect(analyzeCommandForPlan('find . -name "x').allowed).toBe(false);
		expect(analyzeCommandForPlan("find . -name 'x").allowed).toBe(false);
	});
});

describe("firstShellWord", () => {
	test("extracts the program name", () => {
		expect(firstShellWord("ls -la")).toBe("ls");
		expect(firstShellWord("  git   status ")).toBe("git");
		expect(firstShellWord('echo "a b c"')).toBe("echo");
	});

	test("returns undefined for empty or unparsable input", () => {
		expect(firstShellWord("")).toBeUndefined();
		expect(firstShellWord("ls ; pwd")).toBeUndefined();
	});
});

describe("tokenizeSimpleCommand", () => {
	test("splits respecting quotes", () => {
		const result = tokenizeSimpleCommand("ls -la \"two words\" 'a;b'");
		expect(result).toEqual({ words: ["ls", "-la", "two words", "a;b"] });
	});
});
