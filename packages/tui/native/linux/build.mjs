#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Builds the linux native prebuild for the host architecture. `CC` overrides
// the compiler; the default is `cc`.

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-tui-linux-"));
process.on("exit", () => rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function capture(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim();
}

const uname = capture("uname", ["-s"]);
if (uname !== "Linux") fail("Linux native helpers must be built on Linux");

const machine = capture("uname", ["-m"]) ?? "";
const arch = machine === "x86_64" ? "x64" : machine === "aarch64" || machine === "arm64" ? "arm64" : undefined;
if (!arch) fail(`Unsupported Linux architecture: ${machine}`);

const compiler = process.env.CC || "cc";
if (capture(compiler, ["--version"]) === undefined) fail(`Linux C compiler not found: ${compiler}`);

const flags = [
	"-std=c11",
	"-D_POSIX_C_SOURCE=200809L",
	"-Wall",
	"-Wextra",
	"-Werror",
	"-Os",
	"-flto",
	"-fPIC",
	"-pthread",
	"-fvisibility=hidden",
	"-fno-stack-protector",
	"-shared",
	"-nostdlib",
	"-Wl,--unresolved-symbols=ignore-all",
	"-Wl,--no-as-needed",
	"-Wl,-O2",
	"-Wl,--gc-sections",
	// A timed-out private thread may outlive the Node environment that loaded us.
	"-Wl,-z,nodelete",
	"-Wl,-s",
];

const temporaryOutput = join(temporaryDirectory, "linux-platform-x11.node");
const result = spawnSync(
	compiler,
	[...flags, join(scriptDirectory, "src", "linux-platform-x11.c"), "-lxcb", "-o", temporaryOutput],
	{ stdio: "inherit" },
);
if (result.error) fail(`${compiler} failed: ${result.error.message}`);
if (result.status !== 0) fail(`${compiler} failed with exit code ${result.status ?? 1}`);
if (!existsSync(temporaryOutput)) fail(`${compiler} reported success but produced no ${temporaryOutput}`);

const outputDirectory = join(scriptDirectory, "prebuilds", `linux-${arch}`);
const output = join(outputDirectory, "linux-platform-x11.node");
mkdirSync(outputDirectory, { recursive: true });
copyFileSync(temporaryOutput, output);
chmodSync(output, 0o755);
process.stdout.write(`Built ${output}\n`);
