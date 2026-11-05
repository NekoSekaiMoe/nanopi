import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];
const exactVersionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// engines.node 是人工决策点，Renovate 不能碰它（见 renovate.json）。这里兜住
// 「Renovate 之外的人误改」：CI 会红、automerge 不会合。Node 大版本迁移时按五处
// 一起改（engines、workflow 的 node-version、Dockerfile 底图、esbuild target、@types/node）。
const expectedEnginesNode = ">=24.0.0";
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
const packageJsonFiles = [];

function collectPackageJsonFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				collectPackageJsonFiles(join(directory, entry.name));
			}
			continue;
		}

		if (entry.isFile() && entry.name === "package.json") {
			packageJsonFiles.push(join(directory, entry.name));
		}
	}
}

function isInternalWorkspaceDependency(name) {
	return name.startsWith("@nanopi/pi-");
}

function isNonRegistrySpecifier(specifier) {
	return /^(?:workspace:|file:|link:|portal:|git\+|github:|git:|https?:|ssh:|git:\/\/)/.test(specifier);
}

function getVersionSpecifier(specifier) {
	if (!specifier.startsWith("npm:")) return specifier;
	const aliasTarget = specifier.slice("npm:".length);
	const versionSeparator = aliasTarget.lastIndexOf("@");
	if (versionSeparator <= 0) return specifier;
	return aliasTarget.slice(versionSeparator + 1);
}

const failures = [];
const engineFailures = [];

collectPackageJsonFiles(".");

for (const file of packageJsonFiles.sort()) {
	const packageJson = JSON.parse(readFileSync(file, "utf8"));

	for (const section of dependencySections) {
		const dependencies = packageJson[section];
		if (!dependencies) continue;

		for (const [name, specifier] of Object.entries(dependencies)) {
			if (isInternalWorkspaceDependency(name) || isNonRegistrySpecifier(specifier)) continue;
			if (exactVersionPattern.test(getVersionSpecifier(specifier))) continue;
			failures.push(`${file}: ${section}.${name} must be pinned, found ${specifier}`);
		}
	}

	const engines = packageJson.engines;
	if (!engines) continue;
	if (engines.node !== expectedEnginesNode) {
		engineFailures.push(`${file}: engines.node must be ${expectedEnginesNode}, found ${engines.node}`);
	}
}

if (failures.length > 0) {
	console.error("Direct external dependencies must use exact versions:");
	for (const failure of failures) console.error(`  ${failure}`);
}

if (engineFailures.length > 0) {
	console.error("engines.node must stay pinned to the runtime floor:");
	for (const failure of engineFailures) console.error(`  ${failure}`);
}

if (failures.length > 0 || engineFailures.length > 0) process.exit(1);
