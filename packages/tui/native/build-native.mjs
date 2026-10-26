#!/usr/bin/env node
/**
 * Builds the TUI native prebuilds: one `tui-platform.node` per platform/arch
 * under `<platform>/prebuilds/<platform>-<arch>/`. The sources live in `src/`
 * and every platform unit is compiled behind a `NANOPI_PLATFORM_*` macro (see
 * `src/platform-preload.h`), so the platform being built is a flag rather than
 * a directory.
 *
 * Usage:
 *   node native/build-native.mjs <darwin|linux|win32> [...]
 *   node native/build-native.mjs --host        # platform of this machine
 *
 * Every platform defaults to its host architectures; `--arch <arch>` narrows
 * that, and the per-platform env vars the individual toolchains read
 * (`CC`, `CC_X64`, `CC_ARM64`, `SDKROOT`, `NANOPI_TUI_WIN32_TOOLCHAIN`) still
 * apply. The prebuilds are committed, so this is also the only record of what
 * produced them: it prints the toolchain and sha256 of each output.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(scriptDirectory, "..", "..", "..");
const sourceFile = join(scriptDirectory, "src", "platform-preload.h");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "nanopi-tui-native-"));
process.on("exit", () => rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const HOST_PLATFORM = { darwin: "darwin", linux: "linux", win32: "win32" }[process.platform];
const OUTPUT_NAME = "tui-platform.node";

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function capture(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim();
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.error) fail(`${command} failed: ${result.error.message}`);
	if (result.status !== 0) fail(`${command} failed with exit code ${result.status ?? 1}`);
}

function installOutput(platform, arch, temporaryOutput) {
	const outputDirectory = join(scriptDirectory, platform, "prebuilds", `${platform}-${arch}`);
	mkdirSync(outputDirectory, { recursive: true });
	const output = join(outputDirectory, OUTPUT_NAME);
	copyFileSync(temporaryOutput, output);
	chmodSync(output, 0o755);
	process.stdout.write(`Built ${relative(repositoryRoot, output)}\n`);
	process.stdout.write(`  platform: -DNANOPI_PLATFORM_${platform.toUpperCase()}\n`);
	process.stdout.write(`  sha256: ${createHash("sha256").update(readFileSync(output)).digest("hex")}\n`);
}

function buildDirectory(platform, arch) {
	const directory = join(temporaryDirectory, `${platform}-${arch}`);
	mkdirSync(directory, { recursive: true });
	return { directory, output: join(directory, OUTPUT_NAME) };
}

const platformFlags = {
	linux: ["-DNANOPI_PLATFORM_LINUX"],
	darwin: ["-DNANOPI_PLATFORM_DARWIN"],
	win32: ["-DNANOPI_PLATFORM_WIN32"],
};

// ---------------------------------------------------------------- linux

function linuxArch() {
	if (capture("uname", ["-s"]) !== "Linux") fail("The linux prebuilds must be built on Linux (or with a Linux cross toolchain via CC)");
	const machine = capture("uname", ["-m"]) ?? "";
	const arch = machine === "x86_64" ? "x64" : machine === "aarch64" || machine === "arm64" ? "arm64" : undefined;
	if (!arch) fail(`Unsupported Linux architecture: ${machine}`);
	return arch;
}

function buildLinux(arch) {
	if (process.arch !== arch && !process.env.CC) fail(`linux-${arch} needs a cross compiler in CC`);
	const compiler = process.env.CC || "cc";
	if (capture(compiler, ["--version"]) === undefined) fail(`Linux C compiler not found: ${compiler}`);
	// The xcb headers can be absent even when a compiler is installed; without
	// them a real rebuild silently falls back to a stale prebuild.
	if (spawnSync("pkg-config", ["--exists", "xcb"], { stdio: "ignore" }).status !== 0) {
		fail("xcb development headers not found (install libxcb1-dev / libxcb-devel)");
	}

	const { directory, output } = buildDirectory("linux", arch);
	run(compiler, [
		"-std=c11",
		"-D_POSIX_C_SOURCE=200809L",
		...platformFlags.linux,
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
		sourceFile,
		"-lxcb",
		"-o",
		output,
	], { cwd: directory });
	if (!existsSync(output)) fail(`${compiler} reported success but produced no ${output}`);
	installOutput("linux", arch, output);
	process.stdout.write(`  compiler: ${capture(compiler, ["--version"])?.split("\n")[0]}\n`);
	process.stdout.write(`  xcb headers: ${capture("pkg-config", ["--modversion", "xcb"])}\n`);
}

// ---------------------------------------------------------------- darwin

function darwinCompiler() {
	if (process.env.CC) return process.env.CC;
	if (capture("uname", ["-s"]) === "Darwin") {
		const fromXcrun = capture("xcrun", ["--find", "clang"]);
		if (fromXcrun) return fromXcrun;
	}
	return "clang";
}

function darwinSdkFlags() {
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

function buildDarwin(arch) {
	const compiler = darwinCompiler();
	const sdkFlags = darwinSdkFlags();
	if (capture(compiler, ["--version"]) === undefined) fail(`Darwin C compiler not found: ${compiler}`);

	const triple = { arm64: "arm64-apple-macos11.0", x64: "x86_64-apple-macos10.15" }[arch];
	const { directory, output } = buildDirectory("darwin", arch);
	run(compiler, [
		"-x",
		"objective-c",
		"-fobjc-arc",
		"-std=c11",
		...platformFlags.darwin,
		"-Wall",
		"-Wextra",
		// The preload includes the failing unit, so an unused one cannot warn.
		"-Wno-unused-function",
		"-Oz",
		"-flto",
		"-fvisibility=hidden",
		`--target=${triple}`,
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
		output,
	], { cwd: directory });
	if (!existsSync(output)) fail(`${compiler} reported success but produced no ${output}`);
	installOutput("darwin", arch, output);
	process.stdout.write(`  compiler: ${capture(compiler, ["--version"])?.split("\n")[0]}\n`);
	if (sdkFlags.length > 0) process.stdout.write(`  sdk: ${sdkFlags[1]}\n`);
}

// ---------------------------------------------------------------- win32

const mingwTargets = {
	x64: { target: "x86_64-w64-windows-gnu", compilers: ["x86_64-w64-mingw32-gcc", "x86_64-w64-mingw32-clang"], env: "CC_X64" },
	arm64: { target: "aarch64-w64-windows-gnu", compilers: ["aarch64-w64-mingw32-gcc", "aarch64-w64-mingw32-clang"], env: "CC_ARM64" },
};

function commandExists(command) {
	const result = spawnSync(command, ["--version"], { stdio: "ignore" });
	return !result.error || result.error.code !== "ENOENT";
}

function quoteBatch(value) {
	return `"${value.replaceAll('"', '""')}"`;
}

function visualStudioDevCmd() {
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	const candidates = [];
	if (programFilesX86) {
		const vswhere = join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
		if (existsSync(vswhere)) {
			const result = spawnSync(
				vswhere,
				[
					"-latest",
					"-products",
					"*",
					"-requires",
					"Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
					"-property",
					"installationPath",
				],
				{ encoding: "utf8" },
			);
			for (const line of (result.stdout ?? "").split(/\r?\n/)) {
				const installationPath = line.trim();
				if (installationPath) candidates.push(join(installationPath, "Common7", "Tools", "VsDevCmd.bat"));
			}
		}
	}
	for (const base of [process.env.ProgramFiles, programFilesX86]) {
		if (!base) continue;
		for (const edition of ["BuildTools", "Community", "Professional", "Enterprise"]) {
			candidates.push(join(base, "Microsoft Visual Studio", "2022", edition, "Common7", "Tools", "VsDevCmd.bat"));
		}
	}
	return candidates.find((candidate) => existsSync(candidate));
}

function msvcWorks(vsDevCmd) {
	const probeDirectory = join(temporaryDirectory, "msvc-probe");
	mkdirSync(probeDirectory, { recursive: true });
	const batchFile = join(probeDirectory, "probe.cmd");
	const hostArch = process.arch === "arm64" ? "arm64" : "x64";
	writeFileSync(
		batchFile,
		[
			"@echo off",
			`call ${quoteBatch(vsDevCmd)} -no_logo -arch=x64 -host_arch=${hostArch} >nul`,
			"if errorlevel 1 exit /b %errorlevel%",
			"where cl.exe >nul 2>nul",
		].join("\r\n"),
	);
	const result = spawnSync("cmd.exe", ["/d", "/s", "/c", batchFile], { cwd: probeDirectory, stdio: "ignore" });
	return !result.error && result.status === 0;
}

function buildWin32Msvc(arch, vsDevCmd) {
	const { directory, output } = buildDirectory("win32", arch);
	const compileDirectory = join(directory, "obj");
	mkdirSync(compileDirectory, { recursive: true });
	const batchFile = join(directory, "build.cmd");
	const hostArch = process.arch === "arm64" ? "arm64" : "x64";
	writeFileSync(
		batchFile,
		[
			"@echo off",
			`call ${quoteBatch(vsDevCmd)} -no_logo -arch=${arch} -host_arch=${hostArch}`,
			"if errorlevel 1 exit /b %errorlevel%",
			[
				"cl",
				"/nologo",
				// platform-preload.h includes the selected .c or .m unit, which decides its own language.
				"/TP",
				"/std:c11",
				"/DNANOPI_PLATFORM_WIN32",
				"/W4",
				"/O1",
				"/GS-",
				"/LD",
				`/Fe:${quoteBatch(output)}`,
				quoteBatch(sourceFile),
				"/link",
				"/NOENTRY",
				"/NODEFAULTLIB",
				"kernel32.lib",
				"user32.lib",
				"/OPT:REF",
				"/OPT:ICF",
			].join(" "),
			"if errorlevel 1 exit /b %errorlevel%",
		].join("\r\n"),
	);
	run("cmd.exe", ["/d", "/s", "/c", batchFile], { cwd: compileDirectory });
	if (!existsSync(output)) fail(`cl reported success but produced no ${output}`);
	installOutput("win32", arch, output);
}

function buildWin32Mingw(arch) {
	const settings = mingwTargets[arch];
	const compiler =
		process.env[settings.env] ??
		settings.compilers.find(commandExists) ??
		(process.env.CC || (commandExists("clang") ? "clang" : undefined));
	if (!compiler) {
		fail(
			`No Windows cross-compiler found for ${arch}. Install Microsoft C++ Build Tools on Windows, or set ${settings.env} to a MinGW-compatible compiler.`,
		);
	}
	const useTargetFlag = compiler === "clang" || compiler === process.env.CC;

	const { directory, output } = buildDirectory("win32", arch);
	const compileDirectory = join(directory, "obj");
	mkdirSync(compileDirectory, { recursive: true });
	run(compiler, [
		...(useTargetFlag ? [`--target=${settings.target}`] : []),
		"-x",
		"c",
		"-std=c11",
		...platformFlags.win32,
		"-Wall",
		"-Wextra",
		"-Oz",
		"-fno-builtin",
		"-shared",
		"-nostdlib",
		"-Wl,--no-entry",
		"-Wl,--strip-all",
		sourceFile,
		"-lkernel32",
		"-luser32",
		"-o",
		output,
	], { cwd: compileDirectory });
	if (!existsSync(output)) fail(`${compiler} reported success but produced no ${output}`);
	installOutput("win32", arch, output);
}

function buildWin32(arch) {
	const requested = process.env.NANOPI_TUI_WIN32_TOOLCHAIN;
	if (requested && requested !== "msvc" && requested !== "mingw") {
		fail("NANOPI_TUI_WIN32_TOOLCHAIN must be either 'msvc' or 'mingw'");
	}
	const vsDevCmd = visualStudioDevCmd();
	const toolchain = requested ?? (process.platform === "win32" && vsDevCmd && msvcWorks(vsDevCmd) ? "msvc" : "mingw");
	if (toolchain === "msvc") {
		if (!vsDevCmd || !msvcWorks(vsDevCmd)) {
			fail("Microsoft C++ Build Tools not found. Install the Visual Studio C++ workload or set NANOPI_TUI_WIN32_TOOLCHAIN=mingw.");
		}
		buildWin32Msvc(arch, vsDevCmd);
	} else {
		buildWin32Mingw(arch);
	}
}

// ---------------------------------------------------------------- entry

const HOST_ARCHES = { darwin: ["arm64", "x64"], linux: [linuxArch()], win32: ["x64", "arm64"] };
const BUILDERS = { darwin: buildDarwin, linux: buildLinux, win32: buildWin32 };

if (process.argv.includes("--help") || process.argv.includes("-h")) {
	process.stdout.write(`Usage: node native/build-native.mjs <darwin|linux|win32> [...] [--arch <arch>]

Builds the ${OUTPUT_NAME} prebuilds for the named platforms. Sources are shared;
the platform is selected with -DNANOPI_PLATFORM_<PLATFORM> at compile time.

Environment:
  CC                     override the C/Objective-C compiler
  CC_X64 / CC_ARM64      win32 MinGW-compatible compilers per architecture
  SDKROOT                macOS SDK root for darwin builds
  NANOPI_TUI_WIN32_TOOLCHAIN=msvc|mingw
`);
	process.exit(0);
}

const args = process.argv.slice(2);
const archIndex = args.indexOf("--arch");
const requestedArch = archIndex === -1 ? undefined : args.splice(archIndex, 2)[1];
const requested = args.includes("--host") ? [HOST_PLATFORM] : args;
const platforms = requested.length === 0 ? [HOST_PLATFORM] : requested;
for (const platform of platforms) {
	if (!BUILDERS[platform]) fail(`Unknown platform: ${platform} (expected darwin, linux or win32)`);
}
for (const platform of platforms) {
	const arches = requestedArch ? [requestedArch] : HOST_ARCHES[platform];
	for (const arch of arches) BUILDERS[platform](arch);
}
