#!/usr/bin/env node
import { execFileSync } from "node:child_process";

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { installConsumer, packageConsumerDirectoryName, smokeTestNpmConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";
import { execNpmSync } from "./npm-command.mjs";

function printUsage() {
	console.log(`Usage: node scripts/local-release.mjs [options]

Builds and packs the publishable packages, then installs the tarballs into
isolated directories outside the repository for local release testing.

Options:
  --out <dir>          Output directory. Defaults to a new directory under ${tmpdir()}
  --force              Remove --out first if it already exists
  --skip-check         Do not run npm run check before building
  --skip-test          Do not run ./test.sh after building
  --skip-install       Only create the artifact set; do not create isolated installs
  --help               Show this help
`);
}

function buildSingleFileRelease(targetDirectory) {
	execFileSync("bash", ["./scripts/build-single-file.sh", "--skip-install", "--skip-build", "--out", targetDirectory], {
		stdio: "inherit",
	});
	const cliPath = join(targetDirectory, "nanopi.js");
	execFileSync(process.execPath, [cliPath, "--help"], { stdio: "inherit" });
	execFileSync(process.execPath, [cliPath, "--version"], { stdio: "inherit" });
	return cliPath;
}

function createNanoPiShim(installDirectory) {
	const binDirectory = join(installDirectory, "node_modules", ".bin");
	if (process.platform === "win32") {
		if (existsSync(join(binDirectory, "nanopi.cmd"))) {
			writeFileSync(join(installDirectory, "nanopi.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\nanopi.cmd" %*\r\n');
			writeFileSync(join(installDirectory, "nanopi.ps1"), '& "$PSScriptRoot/node_modules/.bin/nanopi.ps1" @args\n');
			return;
		}
		writeFileSync(join(installDirectory, "nanopi.cmd"), '@ECHO off\r\n"%~dp0node_modules\\.bin\\nanopi.exe" %*\r\n');
		writeFileSync(join(installDirectory, "nanopi.ps1"), '& "$PSScriptRoot/node_modules/.bin/nanopi.exe" @args\n');
		return;
	}
	symlinkSync(join("node_modules", ".bin", "nanopi"), join(installDirectory, "nanopi"));
}

const { values } = parseArgs({
	options: {
		force: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
		out: { type: "string" },
		"skip-check": { type: "boolean", default: false },
		"skip-install": { type: "boolean", default: false },
		"skip-test": { type: "boolean", default: false },
	},
});
if (values.help) {
	printUsage();
	process.exit(0);
}
const options = {
	force: values.force,
	outDir: values.out,
	skipCheck: values["skip-check"],
	skipInstall: values["skip-install"],
	skipTest: values["skip-test"],
};
const repoRoot = process.cwd();
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
if (rootPackageJson.name !== "nanopi-monorepo") throw new Error("Run this script from the repository root");

execNpmSync(["run", "generate:models"], { cwd: repoRoot, stdio: "inherit" });
if (!options.skipCheck) execNpmSync(["run", "check"], { cwd: repoRoot, stdio: "inherit" });

const artifactSet = produceArtifactSet({
	build: true,
	force: options.force,
	offlineModelData: true,
	outDir: options.outDir,
	repoRoot,
});
const outDir = artifactSet.artifactDirectory;
const singleFileDirectory = join(outDir, "single-file");
const nodeInstallDirectory = join(outDir, "node");

if (!options.skipTest) execFileSync("bash", ["./test.sh"], { cwd: repoRoot, stdio: "inherit" });

let singleFileCliPath;
if (!options.skipInstall) {
	singleFileCliPath = buildSingleFileRelease(singleFileDirectory);
	const validationRoot = mkdtempSync(join(tmpdir(), "nanopi-local-release-consumers-"));
	try {
		for (const pkg of artifactSet.packages) {
			const directory = pkg.name === codingAgentName
				? nodeInstallDirectory
				: join(validationRoot, "npm", packageConsumerDirectoryName(pkg.name));
			installConsumer({ artifactSet, directory, packageNames: [pkg.name] });
			smokeTestNpmConsumer({ artifactSet, directory, packageName: pkg.name });
			if (pkg.name === codingAgentName) smokeTestCodingAgent(directory);
		}
		createNanoPiShim(nodeInstallDirectory);
	} finally {
		rmSync(validationRoot, { force: true, recursive: true });
	}
}

console.log(`\nLocal release artifacts created: ${outDir}`);
console.log(`Manifest: ${artifactSet.manifestPath}`);
console.log("\nTarballs:");
for (const pkg of artifactSet.packages) console.log(`  ${pkg.tarballPath}`);

if (!options.skipInstall) {
	console.log("\nLocal single-file release:");
	console.log(`  ${singleFileCliPath}`);
	console.log("Run it with Node from outside the repository:");
	console.log(`  node ${singleFileCliPath} --help`);

	console.log("\nIsolated npm install:");
	console.log(`  ${nodeInstallDirectory}`);
	console.log("\nRun the locally packed npm CLI from outside the repository:");
	console.log(`  ${join(nodeInstallDirectory, process.platform === "win32" ? "nanopi.cmd" : "nanopi")} --help`);
}
