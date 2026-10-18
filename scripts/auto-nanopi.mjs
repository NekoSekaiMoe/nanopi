#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Developer wrapper that runs nanopi from this checkout's latest `pnpm run build`.
// Development invocations use NANOPI_EXPERIMENTAL=1 by default; --stable (or a
// leading `update`) uses the next nanopi executable on PATH.
//
// Install from the repository root on Linux/macOS:
//   mkdir -p "$HOME/.local/bin"
//   ln -s "$PWD/scripts/auto-nanopi.mjs" "$HOME/.local/bin/nanopi"
//
// ~/.local/bin must appear before the stable nanopi installation on PATH.

// Symlinked installs must resolve to the checkout, not to the directory holding the symlink.
const invokedFrom = realpathSync(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(dirname(invokedFrom), "..");

const pathEntries = (process.env.PATH ?? "").split(delimiter);
const executableNames = process.platform === "win32" ? ["nanopi.cmd", "nanopi.exe", "nanopi"] : ["nanopi"];

function isExecutableFile(candidate) {
	try {
		if (!statSync(candidate).isFile()) return false;
		accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function findStableNanoPi() {
	for (const entry of pathEntries) {
		for (const name of executableNames) {
			const candidate = join(entry === "" ? "." : entry, name);
			if (!isExecutableFile(candidate)) continue;
			if (resolve(candidate) === invokedFrom) continue;
			return resolve(candidate);
		}
	}
	return undefined;
}

const rawArgs = process.argv.slice(2);
const useStable = rawArgs.includes("--stable") || rawArgs[0] === "update";
const args = rawArgs.filter((argument) => argument !== "--stable");

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function launch(command, commandArgs) {
	// `.cmd`/`.exe` shims need a shell on Windows; everything else is spawned directly.
	const isBinary = /\.(?:cmd|exe)$/i.test(command);
	const child = spawnSync(command, commandArgs, {
		stdio: "inherit",
		shell: process.platform === "win32" && !isBinary,
	});
	if (child.error) fail(`${command} failed: ${child.error.message}`);
	process.exit(child.status ?? 1);
}

if (useStable) {
	const stable = findStableNanoPi();
	if (!stable) fail("could not find a stable nanopi executable after the auto-nanopi wrapper on PATH");
	launch(stable, args);
} else {
	const developmentCli = join(repositoryRoot, "packages/coding-agent/dist/bundle/cli.js");
	if (!isExecutableFile(developmentCli)) {
		fail(`development nanopi build not found (${developmentCli}); run \`pnpm run build\` in ${repositoryRoot}`);
	}
	process.env.NANOPI_EXPERIMENTAL ??= "1";
	const child = spawnSync(process.execPath, [developmentCli, ...args], { stdio: "inherit" });
	if (child.error) fail(`${developmentCli} failed: ${child.error.message}`);
	process.exit(child.status ?? 1);
}
