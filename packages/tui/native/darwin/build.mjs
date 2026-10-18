#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Builds the darwin native prebuilds (arm64 + x64) that ship with @nanopi/pi-tui.
// `CC` overrides the compiler; otherwise `xcrun --find clang` on macOS, else clang.
// The prebuilds are committed, so this is also the only record of what produced
// them: it prints the compiler version, SDK path, and sha256 of each output.

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourceFile = join(scriptDirectory, "src", "darwin-platform.m");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-tui-darwin-"));
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

function commandExists(command) {
	return capture(command, ["--version"]) !== undefined;
}

function resolveCompiler() {
	if (process.env.CC) return process.env.CC;
	if (capture("uname", ["-s"]) === "Darwin") {
		const fromXcrun = capture("xcrun", ["--find", "clang"]);
		if (fromXcrun) return fromXcrun;
	}
	return "clang";
}

function resolveSdkFlags() {
	const sdkRoot = process.env.SDKROOT;
	if (sdkRoot) {
		if (!statSync(sdkRoot, { throwIfNoEntry: false })?.isDirectory()) fail(`SDKROOT does not exist: ${sdkRoot}`);
		return ["-isysroot", sdkRoot, `-F${join(sdkRoot, "System/Library/Frameworks")}`];
	}
	if (capture("uname", ["-s"]) !== "Darwin") return [];
	const path = capture("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
	if (!path) fail("xcrun could not report the macOS SDK path");
	return ["-isysroot", path, `-F${join(path, "System/Library/Frameworks")}`];
}

const compiler = resolveCompiler();
const sdkFlags = resolveSdkFlags();
if (!commandExists(compiler)) fail(`Darwin C compiler not found: ${compiler}`);

const targets = [
	{ arch: "arm64", triple: "arm64-apple-macos11.0" },
	{ arch: "x64", triple: "x86_64-apple-macos10.15" },
];

for (const target of targets) {
	const buildDirectory = join(temporaryDirectory, target.arch);
	const temporaryOutput = join(buildDirectory, "darwin-platform.node");
	mkdirSync(buildDirectory, { recursive: true });

	const result = spawnSync(
		compiler,
		[
			"-fobjc-arc",
			"-std=c11",
			"-Wall",
			"-Wextra",
			"-Oz",
			"-flto",
			"-fvisibility=hidden",
			`--target=${target.triple}`,
			...sdkFlags,
			"-bundle",
			"-undefined",
			"dynamic_lookup",
			"-Wl,-dead_strip",
			"-Wl,-x",
			"-framework",
			"AppKit",
			"-framework",
			"CoreGraphics",
			"-framework",
			"Foundation",
			sourceFile,
			"-o",
			temporaryOutput,
		],
		{ stdio: "inherit" },
	);
	if (result.error) fail(`${compiler} failed: ${result.error.message}`);
	if (result.status !== 0) fail(`${compiler} failed with exit code ${result.status ?? 1}`);
	if (!existsSync(temporaryOutput)) fail(`${compiler} reported success but produced no ${temporaryOutput}`);

	const outputDirectory = join(scriptDirectory, "prebuilds", `darwin-${target.arch}`);
	const output = join(outputDirectory, "darwin-platform.node");
	mkdirSync(outputDirectory, { recursive: true });
	copyFileSync(temporaryOutput, output);
	chmodSync(output, 0o755);
	process.stdout.write(`Built ${output}\n`);
	process.stdout.write(`  compiler: ${capture(compiler, ["--version"])?.split("\n")[0]}\n`);
	if (sdkFlags.length > 0) process.stdout.write(`  sdk: ${sdkFlags[1]}\n`);
	process.stdout.write(`  sha256: ${createHash("sha256").update(readFileSync(output)).digest("hex")}\n`);
}
