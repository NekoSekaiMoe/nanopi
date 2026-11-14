import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// 入口脚本的全部价值有两个：三条校验脚本的失败能传出来（红了就是红了），以及
// 归档的 append-only 真被基线 ref 复查（#728 的验收第 2 条）。所以测试都对着
// 「一个真的 git 仓库里的真的笔记树」跑，不 mock。
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILL = ".agents/skills/write-notes-like-deepseek/scripts";

const gitEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_TERMINAL_PROMPT: "0",
};

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}

// 只搬测试用得到的部分：入口脚本、被它调的三条校验脚本、以及它们共用的
// agent-note-tree.ts。真实的 198 篇笔记搬过来只会让每个用例慢，不增信息量。
async function fixture(t, name) {
	const root = await mkdtemp(join(tmpdir(), `nanopi-verify-agent-notes-${name}-`));
	t.after(() => rm(root, { force: true, recursive: true }));

	mkdirSync(join(root, "scripts"), { recursive: true });
	mkdirSync(join(root, SKILL), { recursive: true });
	for (const file of ["verify-agent-notes.mjs", "check-agent-notes.mjs"]) {
		cpSync(join(repositoryRoot, "scripts", file), join(root, "scripts", file));
	}
	for (const file of ["agent-note-tree.ts", "verify-agent-note-tree.ts", "verify-agent-note-format.ts", "verify-archived-agent-notes.ts"]) {
		cpSync(join(repositoryRoot, SKILL, file), join(root, SKILL, file));
	}

	git(root, ["init", "-q", "--initial-branch=main", "."]);
	git(root, ["config", "user.name", "Test"]);
	git(root, ["config", "user.email", "test@example.com"]);
	writeFileSync(join(root, "README.md"), "x\n");
	git(root, ["add", "README.md"]);
	git(root, ["commit", "-q", "--no-gpg-sign", "-m", "init"]);
	return root;
}

function write(root, path, content) {
	mkdirSync(join(root, path, ".."), { recursive: true });
	writeFileSync(join(root, path), content);
}

function commit(root, message) {
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "--no-gpg-sign", "-m", message]);
}

function run(root, args = []) {
	return spawnSync(process.execPath, [join(root, "scripts", "verify-agent-notes.mjs"), ...args], {
		cwd: root,
		encoding: "utf8",
		env: gitEnv,
	});
}

const GOOD_NOTE = [
	"# Agent Note: 一篇合格的笔记",
	"",
	"Status: implemented",
	"",
	"## Problem",
	"",
	"没问题。",
	"",
	"## Decision",
	"",
	"就这样。",
	"",
	"## Alternatives considered",
	"",
	"没有。",
	"",
	"## Consequences",
	"",
	"没有代价。",
	"",
].join("\n");

test("a clean tree passes", async (t) => {
	const root = await fixture(t, "clean");
	write(root, ".agents/notes/implemented/process/2026-11-14-good.md", GOOD_NOTE);
	commit(root, "add a note");

	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /ok: 1 note\(s\)/);
});

// class 封闭集是脚本判的，`performance` 曾悄悄成为第 7 个 class（#728 里那 11 条错的
// 之一）。门禁要红，而且错误信息要指到具体文件。
test("an unknown class folder fails the gate and names the file", async (t) => {
	const root = await fixture(t, "class");
	write(root, ".agents/notes/rejected/performance/2026-11-14-bad.md", GOOD_NOTE.replace("implemented", "rejected"));
	commit(root, "wrong class");

	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Agent notes failed to verify/);
	assert.match(result.stderr, /tree: exited 1/);
	assert.match(result.stdout + result.stderr, /rejected\/performance\/2026-11-14-bad\.md — unknown class folder "performance"/);
});

test("a broken relative link fails the gate and names both ends", async (t) => {
	const root = await fixture(t, "link");
	write(root, ".agents/notes/implemented/process/2026-11-14-link.md", GOOD_NOTE.replace("没问题。", "见 [gone](./2026-11-14-nowhere.md)。"));
	commit(root, "dead link");

	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stdout + result.stderr, /2026-11-14-link\.md -> "\.\/2026-11-14-nowhere\.md" target file does not exist/);
});

test("a header that drops the blank line fails the format gate", async (t) => {
	const root = await fixture(t, "format");
	write(root, ".agents/notes/implemented/process/2026-11-14-header.md", GOOD_NOTE.replace("Status: implemented\n", "Status: implemented\n换了行\n"));
	commit(root, "bad header");

	const result = run(root);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /format: exited 1/);
	assert.match(result.stdout + result.stderr, /format: implemented\/process\/2026-11-14-header\.md/);
});

// 验收第 2 条：归档之后改已封印条目的 sha256，基线比对必须抓到。这里用 --base 指
// 封印那一版，等价于 CI 传 pull_request.base.sha。
test("a resealed archived note fails once a baseline ref is given", async (t) => {
	const root = await fixture(t, "archived");
	const archived = [
		"# Agent Note: 一篇归档笔记",
		"",
		"Status: implemented",
		"Archived: 2026-11-14",
		"",
		"## Problem",
		"",
		"没有。",
		"",
	].join("\n");
	write(root, ".agents/notes/archived/2026-11-14-old.md", archived);
	const seal = spawnSync(process.execPath, [join(root, SKILL, "verify-archived-agent-notes.ts"), "--write"], { cwd: root, encoding: "utf8", env: gitEnv });
	assert.equal(seal.status, 0, seal.stderr);
	commit(root, "seal");
	const sealed = git(root, ["rev-parse", "HEAD"]);

	assert.equal(run(root, ["--base", sealed]).status, 0);

	// 改正文不改封印：磁盘自校验就会抓到，与基线无关。
	writeFileSync(join(root, ".agents/notes/archived/2026-11-14-old.md"), archived.replace("没有。", "改过了。"));

	const tampered = run(root, ["--base", sealed]);
	assert.equal(tampered.status, 1);
	assert.match(tampered.stdout + tampered.stderr, /seal mismatch/);
});

test("an archived seal rewritten in the manifest is caught against the baseline", async (t) => {
	const root = await fixture(t, "append-only");
	const archived = ["# Agent Note: 一篇归档笔记", "", "Status: implemented", "Archived: 2026-11-14", "", "## Problem", "", "没有。", ""].join("\n");
	write(root, ".agents/notes/archived/2026-11-14-old.md", archived);
	const seal = spawnSync(process.execPath, [join(root, SKILL, "verify-archived-agent-notes.ts"), "--write"], { cwd: root, encoding: "utf8", env: gitEnv });
	assert.equal(seal.status, 0, seal.stderr);
	commit(root, "seal");
	const sealed = git(root, ["rev-parse", "HEAD"]);

	const manifestPath = join(root, ".agents/notes/archived/manifest.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.files["archived/2026-11-14-old.md"] = `sha256:${"0".repeat(64)}`;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

	const result = run(root, ["--base", sealed]);
	assert.equal(result.status, 1);
	assert.match(result.stdout + result.stderr, /seal added\/changed\/removed relative to/);
});

// 提醒那条不能把门禁带红，也不能因为自己崩掉就让绿变红。
test("the four-questions reminder never turns the gate red", async (t) => {
	const root = await fixture(t, "reminder");
	write(root, "packages/coding-agent/src/a.ts", "y\n".repeat(60));
	commit(root, "big change with no note");

	const result = run(root);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Re-run the four questions/);
});
