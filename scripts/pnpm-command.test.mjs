import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePnpmCommand } from "./pnpm-command.mjs";

const isWin32 = process.platform === "win32";

function writeExecutable(filePath, contents) {
	writeFileSync(filePath, contents, { mode: 0o755 });
	chmodSync(filePath, 0o755);
}

test("resolvePnpmCommand prefers runnable pnpm on PATH", { skip: isWin32 }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "nanopi-pnpm-cmd-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const binDir = join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeExecutable(join(binDir, "pnpm"), "#!/bin/sh\nexit 0\n");

	const resolved = resolvePnpmCommand({
		repoRoot: join(root, "repo"),
		env: { PATH: binDir },
		nodeExecPath: join(root, "missing", "node"),
	});
	assert.equal(resolved?.command, "pnpm");
	assert.deepEqual(resolved?.prefixArgs, []);
});

test("resolvePnpmCommand skips broken pnpm symlink and falls back to workspace pnpm.mjs", { skip: isWin32 }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "nanopi-pnpm-cmd-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const binDir = join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	symlinkSync(join(root, "does-not-exist"), join(binDir, "pnpm"));

	const repoRoot = join(root, "repo");
	const localCli = join(repoRoot, "node_modules", "pnpm", "bin", "pnpm.mjs");
	mkdirSync(join(repoRoot, "node_modules", "pnpm", "bin"), { recursive: true });
	writeFileSync(localCli, "// stub\n");

	const resolved = resolvePnpmCommand({
		repoRoot,
		env: { PATH: binDir },
		nodeExecPath: join(root, "node-bin", "node"),
	});
	assert.equal(resolved?.command, join(root, "node-bin", "node"));
	assert.deepEqual(resolved?.prefixArgs, [localCli]);
	assert.equal(resolved?.shell, false);
});

test("resolvePnpmCommand uses sibling pnpm next to node when PATH lacks pnpm", { skip: isWin32 }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "nanopi-pnpm-cmd-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const nodeBinDir = join(root, "node-bin");
	mkdirSync(nodeBinDir, { recursive: true });
	const siblingPnpm = join(nodeBinDir, "pnpm");
	writeExecutable(siblingPnpm, "#!/bin/sh\nexit 0\n");

	const resolved = resolvePnpmCommand({
		repoRoot: join(root, "repo"),
		env: { PATH: join(root, "empty-bin") },
		nodeExecPath: join(nodeBinDir, "node"),
	});
	assert.equal(resolved?.command, siblingPnpm);
	assert.deepEqual(resolved?.prefixArgs, []);
});

test("resolvePnpmCommand falls back to corepack when pnpm and node_modules are absent", { skip: isWin32 }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "nanopi-pnpm-cmd-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const binDir = join(root, "bin");
	mkdirSync(binDir, { recursive: true });
	writeExecutable(join(binDir, "corepack"), "#!/bin/sh\nexit 0\n");

	const resolved = resolvePnpmCommand({
		repoRoot: join(root, "repo"),
		env: { PATH: binDir },
		nodeExecPath: join(root, "missing", "node"),
	});
	assert.equal(resolved?.command, "corepack");
	assert.deepEqual(resolved?.prefixArgs, ["pnpm"]);
	assert.equal(resolved?.env.COREPACK_ENABLE_DOWNLOAD_PROMPT, "0");

	const customPrompt = resolvePnpmCommand({
		repoRoot: join(root, "repo"),
		env: { PATH: binDir, COREPACK_ENABLE_DOWNLOAD_PROMPT: "1" },
		nodeExecPath: join(root, "missing", "node"),
	});
	assert.equal(customPrompt?.env.COREPACK_ENABLE_DOWNLOAD_PROMPT, "1");
});

test("resolvePnpmCommand returns undefined when no pnpm candidate exists", { skip: isWin32 }, (t) => {
	const root = mkdtempSync(join(tmpdir(), "nanopi-pnpm-cmd-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const resolved = resolvePnpmCommand({
		repoRoot: join(root, "repo"),
		env: { PATH: join(root, "empty-bin") },
		nodeExecPath: join(root, "missing", "node"),
	});
	assert.equal(resolved, undefined);
});
