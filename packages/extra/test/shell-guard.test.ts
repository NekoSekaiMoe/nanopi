import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { analyzeFileInspection, shellGuardNotice } from "../src/shell-guard.ts";

const root = mkdtempSync(join(tmpdir(), "shellguard-"));
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(root, "src", "a.ts"), "one\ntwo\n");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The blocked command, or undefined when the line is let through. */
function hit(command: string): string | undefined {
	const verdict = analyzeFileInspection(command, root);
	return verdict.checked ? verdict.hit?.command : undefined;
}

describe("shell guard: file reads the tools do better", () => {
	test("cat, head, tail, sed -n and recursive grep are caught", () => {
		expect(hit("cat src/a.ts")).toBe("cat src/a.ts");
		expect(hit("cat -n src/a.ts")).toBe("cat src/a.ts");
		expect(hit("head -20 src/a.ts")).toBe("head src/a.ts");
		expect(hit("head -n 20 src/a.ts")).toBe("head src/a.ts");
		expect(hit("tail -n20 src/a.ts")).toBe("tail src/a.ts");
		expect(hit("sed -n '1,40p' src/a.ts")).toBe("sed src/a.ts");
		expect(hit("grep -rn foo")).toBe("grep foo");
		expect(hit("rg foo")).toBe("rg foo");
	});

	test("the hint names the tool call, including sed's line number", () => {
		const verdict = analyzeFileInspection("sed -n '12,40p' src/a.ts", root);
		const notice = shellGuardNotice(verdict.checked ? (verdict.hit ?? expect.unreachable()) : expect.unreachable());
		expect(notice).toContain("read src/a.ts tool with offset=12");
		expect(notice).toContain("Blocked by the shell guard");
		expect(notice).toContain("gitignore");
	});

	test("a line of nothing but file reads is caught even when it is several commands", () => {
		expect(hit("cat src/a.ts && cat src/a.ts")).toBe("cat src/a.ts");
	});

	test("shells and wrappers do not hide the read", () => {
		expect(hit("sudo cat src/a.ts")).toBe("cat src/a.ts");
		expect(hit("FOO=1 cat src/a.ts")).toBe("cat src/a.ts");
	});
});

describe("shell guard: what must keep running", () => {
	test("pipes, redirections, and subshells are not inspections", () => {
		expect(hit("cat src/a.ts | wc -l")).toBeUndefined();
		expect(hit("head -20 src/a.ts > /tmp/out")).toBeUndefined();
		expect(hit("echo hi && cat src/a.ts")).toBeUndefined();
		expect(hit("(cat src/a.ts)")).toBeUndefined();
	});

	test("stdin, heredocs, and process substitution are left alone", () => {
		expect(hit("echo hi | cat")).toBeUndefined();
		expect(hit("cat <<'EOF'\ntext\nEOF")).toBeUndefined();
		expect(hit("grep foo < src/a.ts")).toBeUndefined();
	});

	test("editing and conditional forms pass through", () => {
		expect(hit("sed -i 's/a/b/' src/a.ts")).toBeUndefined();
		expect(hit("sed -n 's/a/b/p' src/a.ts")).toBeUndefined();
		expect(hit("grep -q foo src/a.ts")).toBeUndefined();
		expect(hit("grep -rl foo src")).toBeUndefined();
		expect(hit("cat -n src/a.ts | sed -n '1,5p'")).toBeUndefined();
	});

	test("a file it cannot see is not the read tool's business", () => {
		expect(hit("cat *.ts")).toBeUndefined();
		expect(hit("cat /dev/null")).toBeUndefined();
		expect(hit("cat missing.txt")).toBeUndefined();
		expect(hit("cat -")).toBeUndefined();
	});

	test("non-recursive grep and unrelated commands pass through", () => {
		expect(hit("grep foo src/a.ts")).toBeUndefined();
		expect(hit("pnpm test")).toBeUndefined();
		expect(hit("git status")).toBeUndefined();
		expect(hit("ls -la")).toBeUndefined();
	});
});
