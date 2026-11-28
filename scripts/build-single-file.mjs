#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { exitStatus, repositoryRoot } from "./lib/node-runner.mjs";
import { resolvePnpmCommand } from "./pnpm-command.mjs";

// Builds the zero-dependency single-file `nanopi.js` distribution locally.
// Mirrors .github/workflows/build-binaries.yml.
//
// Usage:
//   node scripts/build-single-file.mjs [--skip-install] [--skip-build]
//                                      [--offline-model-data] [--out <dir>]

const { values } = parseArgs({
	options: {
		"skip-install": { type: "boolean", default: false },
		"skip-build": { type: "boolean", default: false },
		"offline-model-data": { type: "boolean", default: false },
		out: { type: "string" },
		help: { type: "boolean", default: false },
	},
});

if (values.help) {
	process.stdout.write(`Usage: node scripts/build-single-file.mjs [options]

  --skip-install       Skip pnpm install
  --skip-build         Skip the workspace build
  --offline-model-data Build with bundled model data instead of refreshing it
  --out <dir>          Output directory (default: packages/coding-agent/binaries)
`);
	process.exit(0);
}

const outputDirectory = resolve(repositoryRoot, values.out || "packages/coding-agent/binaries");
const bundleOutput = join(outputDirectory, "nanopi.js");

function run(step, command, args, { env = process.env, shell = process.platform === "win32" } = {}) {
	process.stdout.write(`==> ${step}\n`);
	const result = spawnSync(command, args, { cwd: repositoryRoot, env, stdio: "inherit", shell });
	const status = exitStatus(result);
	if (status !== 0) process.exit(status);
}

function runPnpm(step, args) {
	const resolved = resolvePnpmCommand({ repoRoot: repositoryRoot });
	if (!resolved) {
		process.stderr.write("pnpm was not found on PATH, in node_modules/pnpm, or via corepack.\n");
		process.exit(127);
	}
	run(step, resolved.command, [...resolved.prefixArgs, ...args], { env: resolved.env, shell: resolved.shell });
}

if (values["skip-install"]) {
	process.stdout.write("==> Skipping pnpm install (--skip-install)\n");
} else {
	runPnpm("Installing dependencies...", ["install", "--frozen-lockfile", "--ignore-scripts"]);
}

if (values["skip-build"]) {
	process.stdout.write("==> Skipping package build (--skip-build)\n");
} else {
	runPnpm(
		values["offline-model-data"] ? "Building all packages with bundled model data..." : "Building all packages...",
		["run", values["offline-model-data"] ? "build:offline" : "build"],
	);
}

process.stdout.write("==> Building single-file distribution...\n");
mkdirSync(outputDirectory, { recursive: true });
run(
	"Bundling nanopi.js",
	process.execPath,
	[join(repositoryRoot, "scripts", "build-coding-agent-single-file.mjs"), "--out", bundleOutput],
	{ shell: false },
);

const bytes = statSync(bundleOutput).size;
process.stdout.write(
	`\n==> Build complete: ${bundleOutput} (${(bytes / 1024 / 1024).toFixed(1)} MiB)\n\n` +
		`Smoke test from outside the repository:\n  node "${bundleOutput}" --version\n`,
);
