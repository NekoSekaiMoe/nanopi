#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { exitStatus } from "./scripts/lib/node-runner.mjs";

// Runs the test suite with an isolated HOME, temp dir, and git/npm configuration
// so a developer's credentials and dotfiles cannot change the result. The child
// environment is built from scratch (`env -i`) rather than filtered, because
// removing credentials is easy to get wrong and impossible to keep complete.

const temporaryParent = (process.env.TMPDIR ?? tmpdir()).replace(/\/+$/, "");
const testRoot = mkdtempSync(join(temporaryParent, "nanopi-test."));
const home = join(testRoot, "home");
const tempDirectory = join(testRoot, "tmp");
const cacheDirectory = join(testRoot, "cache");
// `false` exits 1, which makes every credential prompt fail instead of hanging.
const gitAskpass = process.platform === "win32" ? "" : "/usr/bin/false";

// `.nanopi-test-owned` marks the directory as ours so cleanup can verify
// ownership before deleting anything.
for (const directory of [join(home, ".config"), tempDirectory, join(cacheDirectory, "npm")]) mkdirSync(directory, { recursive: true });
for (const file of [".nanopi-test-owned", "npm-userconfig", "npm-globalconfig"]) writeFileSync(join(testRoot, file), "");

function isOwnedTestDirectory() {
	if (!testRoot.startsWith(`${temporaryParent}${sep}nanopi-test.`)) return false;
	const stats = statSync(testRoot, { throwIfNoEntry: false });
	if (!stats?.isDirectory() || stats.isSymbolicLink()) return false;
	return statSync(join(testRoot, ".nanopi-test-owned"), { throwIfNoEntry: false })?.isFile() === true;
}

let status = 0;
process.on("exit", () => {
	if (!isOwnedTestDirectory()) {
		process.stderr.write(`Refusing to remove unverified test directory: ${testRoot}\n`);
		process.exitCode = process.exitCode || 1;
		return;
	}
	rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const environment = {
	PATH: process.env.PATH ?? "",
	PWD: process.cwd(),
	HOME: home,
	USERPROFILE: home,
	TMPDIR: tempDirectory,
	TMP: tempDirectory,
	TEMP: tempDirectory,
	XDG_CONFIG_HOME: join(home, ".config"),
	XDG_CACHE_HOME: cacheDirectory,
	LANG: "C",
	LC_ALL: "C",
	TZ: "UTC",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
	GIT_ASKPASS: gitAskpass,
	GIT_EDITOR: "true",
	GIT_SEQUENCE_EDITOR: "true",
	NPM_CONFIG_USERCONFIG: join(testRoot, "npm-userconfig"),
	NPM_CONFIG_GLOBALCONFIG: join(testRoot, "npm-globalconfig"),
	NPM_CONFIG_CACHE: join(cacheDirectory, "npm"),
	NANOPI_NO_LOCAL_LLM: "1",
	AWS_EC2_METADATA_DISABLED: "true",
};

// Native Windows needs these inherited values to launch child processes.
for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
	const value = process.env[name];
	if (value !== undefined && value !== "") environment[name] = value;
}

// CI detection is preserved only for runner behavior and test reporting.
for (const name of ["CI", "GITHUB_ACTIONS"]) {
	const value = process.env[name];
	if (value !== undefined && value !== "") environment[name] = value;
}

process.stdout.write(`Running tests without API keys in isolated home: ${home}\n`);
const result = spawnSync("pnpm", ["test"], {
	stdio: "inherit",
	env: environment,
	shell: process.platform === "win32",
	cwd: process.cwd(),
});
status = exitStatus(result);
process.exitCode = status;
