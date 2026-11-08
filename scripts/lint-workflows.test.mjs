import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./lint-workflows.mjs", import.meta.url));

function lint(contents) {
	const directory = mkdtempSync(join(tmpdir(), "lint-workflows-"));
	try {
		const path = join(directory, "workflow.yml");
		writeFileSync(path, contents);
		const result = spawnSync(process.execPath, [script, path], {
			encoding: "utf8",
		});
		return {
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function workflow(steps) {
	return [
		"on: push",
		"jobs:",
		"  test:",
		"    runs-on: ubuntu-latest",
		"    steps:",
		...steps,
		"",
	].join("\n");
}

// 回归测试对应 shinytale/nanopi#607：原来这条门禁靠 curl 从 GitHub Releases 下
// actionlint/shellcheck 二进制，CDN 返 504 就让必选检查变红。换成 npm 上的 wasm
// 版本后，这些用例不需要网络，也不碰 runner 上预装的二进制。
test("accepts a clean workflow", () => {
	const result = lint(
		workflow(["      - name: Say hello", "        run: echo hello"]),
	);
	assert.equal(result.status, 0, result.stderr);
});

test("reports shellcheck findings with the workflow line number", () => {
	// echo $UNQUOTED 在第 8 行，SC2086 相对 run 块是第 2 行。
	const result = lint(
		workflow([
			"      - name: Unquoted",
			"        run: |",
			"          echo hello",
			"          echo $UNQUOTED",
		]),
	);
	assert.equal(result.status, 1, result.stdout);
	assert.match(result.stderr, /workflow\.yml:8:6: SC2086/);
});

test("reports actionlint findings for a malformed action reference", () => {
	const result = lint(workflow(["      - uses: actions/checkout"]));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /invalid format because ref is missing/);
});

test("reports actionlint findings for a job-level if that reads env", () => {
	// #530 那类错误：job 级 if 读不到 env，整份工作流解析失败、一条 check-run 都不产生。
	const contents = [
		"on: push",
		"jobs:",
		"  test:",
		"    runs-on: ubuntu-latest",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: 这里要写的就是 GitHub 的表达式字面量。
		"    if: " + "$" + "{{ env.FLAG != '' }}",
		"    steps:",
		"      - run: echo hello",
		"",
	].join("\n");
	const result = lint(contents);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /context "env" is not allowed here/);
});

test("ignores run blocks that are not bash", () => {
	const result = lint(
		workflow([
			"      - name: Windows",
			"        shell: pwsh",
			"        run: |",
			"          $x = 1",
			"          Write-Output $x",
		]),
	);
	assert.equal(result.status, 0, result.stderr);
});

test("expands workflow expressions before shellchecking", () => {
	// `${{ github.sha }}` 直接喂给 shellcheck 会被当成 `${ ...`，报 SC2296。
	const result = lint(
		workflow([
			"      - name: Expression",
			"        run: echo ${" + "{ github.sha }" + "}",
		]),
	);
	assert.equal(result.status, 0, result.stderr);
});
