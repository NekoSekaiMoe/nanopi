#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { exitStatus, repositoryRoot } from "./lib/node-runner.mjs";

// Creates the deterministic source archive uploaded with GitHub releases.
//
// Usage:
//   pnpm run hydrate:model-data
//   node scripts/create-source-archive.mjs --version <version> --ref <git-ref> --out <archive.tar.gz>

const usage = () => "Usage: node scripts/create-source-archive.mjs --version <version> [--ref <git-ref>] --out <archive.tar.gz>";

const { values } = parseArgs({
	options: {
		version: { type: "string" },
		ref: { type: "string", default: "HEAD" },
		out: { type: "string" },
		help: { type: "boolean", default: false },
	},
});

if (values.help) {
	process.stdout.write(`${usage()}\n`);
	process.exit(0);
}
if (!values.version || !values.out) {
	process.stderr.write(`${usage()}\n`);
	process.exit(1);
}

function rule(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

// Date tags (vYYYYMMDD) may omit the minor/patch parts that package.json carries
// (20261013 vs 20261013.0.0), and a same-day follow-up (v20261013.1.0) names the
// release line rather than the exact package version. The date part is the
// release identity: comparing all three would demand a package.json bump the
// release flow never makes.
function releaseDate(version) {
	return version.split(".")[0];
}

const version = values.version;
const sourceRef = values.ref;
if (!/^[0-9A-Za-z][0-9A-Za-z._-]*$/.test(version)) rule(`Invalid version: ${version}`);

const output = isAbsolute(values.out) ? values.out : resolve(process.cwd(), values.out);
mkdirSync(dirname(output), { recursive: true });

function git(args, options = {}) {
	const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", ...options });
	const status = exitStatus(result);
	if (status !== 0) {
		process.stderr.write(result.stderr ?? "");
		rule(`git ${args.join(" ")} failed with exit ${status}`);
	}
	return (result.stdout ?? "").trimEnd();
}

function run(command, args, options = {}) {
	// The source archive is written through a spawnSync pipe; the default
	// maxBuffer of 1 MiB overflows for archives larger than that and kills
	// git with ENOBUFS, so allow the archive and its gzip output (~25 MiB
	// for this repo) to be buffered.
	const result = spawnSync(command, args, { maxBuffer: 512 * 1024 * 1024, ...options });
	const status = exitStatus(result);
	if (status !== 0) rule(`${command} ${args.join(" ")} failed with exit ${status}`);
	return result;
}

const commit = git(["rev-parse", "--verify", "--end-of-options", `${sourceRef}^{commit}`]);
// Read through the tree, not `<commit>:<path>`: `git show` on a commit without a
// cache-tree records a bogus entry for the path's parent directory instead of
// failing, so a checkout of a large tag could read the wrong file. The tree is
// also the base of the temporary index below.
const tree = git(["rev-parse", "--verify", "--end-of-options", `${commit}^{tree}`]);
const packageVersion = JSON.parse(git(["cat-file", "blob", `${tree}:packages/coding-agent/package.json`])).version;
if (releaseDate(packageVersion) !== releaseDate(version)) {
	rule(
		`Version ${version} does not match package version ${packageVersion} at ${sourceRef} (${commit}); ` +
			`the release tag's date must match the package.json version`,
	);
}

const modelDataDirectory = join(repositoryRoot, "packages/ai/src/providers/data");
const modelDataManifest = join(modelDataDirectory, ".manifest.json");
const missingModelData = "Generated model data is missing. Run pnpm run hydrate:model-data first.";
if (!statSync(modelDataManifest, { throwIfNoEntry: false })?.isFile()) rule(missingModelData);
const generatedModelData = readdirSync(modelDataDirectory, { withFileTypes: true })
	.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
	.map((entry) => join(modelDataDirectory, entry.name));
if (generatedModelData.length === 0) rule(missingModelData);

const archiveRoot = `nanopi-${version}`;
const stagingDirectory = mkdtempSync(join(tmpdir(), "nanopi-source-archive-"));
const temporaryArchive = join(stagingDirectory, "source.tar.gz");
process.on("exit", () => rmSync(stagingDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

// Add the ignored release model-data snapshot to a temporary index based on the
// release commit. Archiving the resulting tree keeps the source artifact
// deterministic for the same commit and generated model data.
const temporaryIndex = join(stagingDirectory, "index");
const indexEnvironment = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
git(["read-tree", tree], { env: indexEnvironment });
git(["add", "-f", "--", modelDataManifest, ...generatedModelData], { env: indexEnvironment });
const archiveTree = git(["write-tree"], { env: indexEnvironment });
const archiveMtime = git(["show", "-s", "--format=%ct", commit]);

const tar = run("git", ["archive", "--format=tar", `--prefix=${archiveRoot}/`, `--mtime=@${archiveMtime}`, archiveTree], {
	cwd: repositoryRoot,
	stdio: ["ignore", "pipe", "inherit"],
});
const compressed = run("gzip", ["-n", "-9"], { input: tar.stdout, stdio: ["pipe", "pipe", "inherit"] });
const outputStream = createWriteStream(temporaryArchive);
outputStream.end(compressed.stdout);
await new Promise((resolveWrite, rejectWrite) => {
	outputStream.on("finish", resolveWrite);
	outputStream.on("error", rejectWrite);
});

const manifest = run("tar", ["-tzf", temporaryArchive], { encoding: "utf8" })
	.stdout.split("\n")
	.map((line) => line.trim())
	.filter(Boolean);
const entries = new Set(manifest);

const requiredPaths = [
	"package.json",
	"scripts/build-single-file.mjs",
	"scripts/build-coding-agent-single-file.mjs",
	"packages/ai/src/models.generated.ts",
	"packages/ai/src/providers/data/.manifest.json",
	"packages/tui/native/napi.h",
	"packages/tui/native/clipboard.h",
	"packages/tui/native/darwin/src/darwin-platform.m",
	"packages/tui/native/darwin/build.mjs",
	"packages/tui/native/darwin/prebuilds/darwin-arm64/darwin-platform.node",
	"packages/tui/native/darwin/prebuilds/darwin-x64/darwin-platform.node",
	"packages/tui/native/linux/build.mjs",
	"packages/tui/native/linux/src/linux-platform-x11.c",
	"packages/tui/native/linux/prebuilds/linux-arm64/linux-platform-x11.node",
	"packages/tui/native/linux/prebuilds/linux-x64/linux-platform-x11.node",
	"packages/tui/native/win32/src/win32-platform.c",
	"packages/tui/native/win32/prebuilds/win32-arm64/win32-platform.node",
	"packages/tui/native/win32/prebuilds/win32-x64/win32-platform.node",
	"packages/coding-agent/package.json",
	"packages/coding-agent/src/utils/image-resize-worker.ts",
	"packages/coding-agent/src/core/export-html/template.css",
];

for (const path of requiredPaths) {
	if (!entries.has(`${archiveRoot}/${path}`)) rule(`Source archive is missing required path: ${path}`);
}
for (const entry of manifest) {
	if (!entry.startsWith(`${archiveRoot}/`)) rule(`Source archive contains a path outside ${archiveRoot}/: ${entry}`);
	if (/(^|\/)node_modules\//.test(entry) || /(^|\/)packages\/coding-agent\/binaries\//.test(entry)) {
		rule("Source archive contains generated dependencies or binaries");
	}
}

const validationRoot = join(stagingDirectory, "validation");
mkdirSync(validationRoot, { recursive: true });
run("tar", ["-xzf", temporaryArchive, "-C", validationRoot]);
run(process.execPath, [join(validationRoot, archiveRoot, "packages/ai/scripts/check-model-data.ts")]);

try {
	writeFileSync(output, readFileSync(temporaryArchive));
} catch (error) {
	rule(`Could not write ${output}: ${error.message}`);
}
process.stdout.write(`${output}\n`);
