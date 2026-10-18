import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Shared Node-side helpers for the scripts that used to be shell scripts. Each
 * one exists because a `.mjs` file is not a shell: it cannot `unset` the
 * caller's environment (it receives a copy), it cannot `exec`, and it cannot
 * rely on `#!/usr/bin/env bash`-style probing of compilers and SDKs.
 */

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Environment for a child process with `names` removed. Deleting keys from a
 * copy is the portable spelling of `unset`; assigning `undefined` leaks the
 * string "undefined" through some spawn paths.
 */
export function environmentWithout(names, environment = process.env) {
	const copy = { ...environment };
	for (const name of names) delete copy[name];
	return copy;
}

/** Path argument -> module specifier. Raw paths break on `#`, `?`, `%` and drive letters. */
export function fileUrl(path) {
	return pathToFileURL(path).href;
}

/**
 * `--import` flags for running TypeScript entry points. `ts-import.mjs` always
 * goes first: it is a no-op where Node strips TypeScript natively, and it is
 * required on builds that cannot (Debian sets
 * `process.features.typescript === false`) — including for the later preloads,
 * which are TypeScript themselves.
 */
export function typescriptPreloadArguments(preloads, root = repositoryRoot) {
	return ["--import", fileUrl(join(root, "ts-import.mjs")), ...preloads.flatMap((path) => ["--import", fileUrl(path)])];
}

/**
 * Replaces this process with `node <script> [args...]` so exit codes and signal
 * handling match a direct invocation. Windows has no `execve`; there the child
 * is spawned and its status becomes ours.
 */
export function runNode(script, args, options = {}) {
	const { preloads = [], environment = process.env, stdio = "inherit" } = options;
	const argv = [...typescriptPreloadArguments(preloads), script, ...args];
	if (process.platform !== "win32" && process.execve) process.execve(process.execPath, [process.execPath, ...argv], environment);
	const result = spawnSync(process.execPath, argv, { stdio, env: environment });
	if (result.error) throw result.error;
	process.exit(result.status ?? 1);
}

/** Exit status for a spawn result; a missing binary is 127, like a shell. */
export function exitStatus(result) {
	if (result.error) return result.error.code === "ENOENT" ? 127 : 1;
	if (result.signal) return 128;
	return result.status ?? 0;
}

export function commandExists(command, options = {}) {
	const result = spawnSync(command, ["--version"], { stdio: "ignore", shell: process.platform === "win32", ...options });
	return !result.error || result.error.code !== "ENOENT";
}

export function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}
