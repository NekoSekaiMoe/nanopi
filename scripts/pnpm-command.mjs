import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { repositoryRoot } from "./lib/node-runner.mjs";

function isRunnable(command, args, { env, shell }) {
	const result = spawnSync(command, args, { env, stdio: "ignore", shell });
	return !result.error && result.status === 0;
}

/**
 * Resolve a working pnpm invocation even under sanitized build environments
 * (e.g. `dpkg-buildpackage`, `debuild`, or `sudo`) where user-local bins are
 * absent from `PATH` or a system symlink is broken.
 */
export function resolvePnpmCommand({ repoRoot = repositoryRoot, env = process.env, nodeExecPath = process.execPath } = {}) {
	const win32 = process.platform === "win32";
	if (isRunnable("pnpm", ["--version"], { env, shell: win32 })) {
		return { command: "pnpm", prefixArgs: [], shell: win32, env };
	}

	const siblingPnpm = join(dirname(nodeExecPath), win32 ? "pnpm.cmd" : "pnpm");
	if (existsSync(siblingPnpm) && isRunnable(siblingPnpm, ["--version"], { env, shell: win32 })) {
		return { command: siblingPnpm, prefixArgs: [], shell: win32, env };
	}

	const localPnpmCli = join(repoRoot, "node_modules", "pnpm", "bin", "pnpm.mjs");
	if (existsSync(localPnpmCli)) {
		return { command: nodeExecPath, prefixArgs: [localPnpmCli], shell: false, env };
	}

	const corepackEnv = { COREPACK_ENABLE_DOWNLOAD_PROMPT: env.COREPACK_ENABLE_DOWNLOAD_PROMPT ?? "0", ...env };
	if (isRunnable("corepack", ["--version"], { env: corepackEnv, shell: win32 })) {
		return { command: "corepack", prefixArgs: ["pnpm"], shell: win32, env: corepackEnv };
	}

	const siblingCorepack = join(dirname(nodeExecPath), win32 ? "corepack.cmd" : "corepack");
	if (existsSync(siblingCorepack) && isRunnable(siblingCorepack, ["--version"], { env: corepackEnv, shell: win32 })) {
		return { command: siblingCorepack, prefixArgs: ["pnpm"], shell: win32, env: corepackEnv };
	}

	return undefined;
}

export function execPnpmSync(args, options = {}) {
	const { repoRoot = repositoryRoot, env = process.env, ...spawnOptions } = options;
	const resolved = resolvePnpmCommand({ repoRoot, env });
	if (!resolved) {
		return execFileSync("pnpm", args, { shell: process.platform === "win32", env, ...spawnOptions });
	}
	return execFileSync(resolved.command, [...resolved.prefixArgs, ...args], {
		shell: resolved.shell,
		env: resolved.env,
		...spawnOptions,
	});
}
