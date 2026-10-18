import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { installConsumer, smokeTestPnpmConsumer, wireConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), contents);
	}
}

function createArtifactSet(t) {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "nanopi-local-package-install-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const root = join(temporaryRoot, "fixture with spaces");
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot, { recursive: true });
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	writePackage(
		join(repoRoot, "packages", "shared"),
		{
			name: "@nanopi-package-test/shared",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
			files: ["dist"],
		},
		{
			"dist/index.js": 'export const marker = "local artifact";\n',
			"dist/index.d.ts": 'export declare const marker: "local artifact";\n',
		},
	);
	writePackage(
		join(repoRoot, "packages", "target"),
		{
			name: "@nanopi-package-test/target",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: {
				".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
				"./feature": { types: "./dist/feature.d.ts", import: "./dist/feature.js" },
			},
			bin: { target: "./dist/cli.js" },
			files: ["dist"],
			dependencies: { "@nanopi-package-test/shared": "1.0.0" },
		},
		{
			"dist/index.js": 'import { marker } from "@nanopi-package-test/shared";\nexport { marker };\n',
			"dist/index.d.ts": 'export { marker } from "@nanopi-package-test/shared";\n',
			"dist/feature.js": "export const feature = true;\n",
			"dist/feature.d.ts": "export declare const feature: true;\n",
			"dist/cli.js": "#!/usr/bin/env node\n",
		},
	);
	writePackage(
		join(repoRoot, "packages", "second"),
		{
			name: "@nanopi-package-test/second",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			files: ["dist"],
		},
		{
			"dist/index.js": "export const second = true;\n",
			"dist/index.d.ts": "export declare const second: true;\n",
		},
	);
	return {
		artifactSet: produceArtifactSet({ build: false, outDir: join(root, "artifacts"), repoRoot, source: null }),
		root,
	};
}

test("wires multiple direct packages without registry fallbacks", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	const consumerDirectory = join(root, "consumer");
	mkdirSync(consumerDirectory);
	writeFileSync(
		join(consumerDirectory, "package.json"),
		'{"private":true,"type":"module","dependencies":{"@nanopi-package-test/target":"1.0.0","@nanopi-package-test/second":"1.0.0"}}\n',
	);
	wireConsumer({
		artifactSet,
		consumerDirectory,
		packageNames: ["@nanopi-package-test/target", "@nanopi-package-test/second"],
	});
	execFileSync("pnpm", ["install", "--ignore-scripts"], { cwd: consumerDirectory, stdio: "pipe" });

	const manifest = JSON.parse(readFileSync(join(consumerDirectory, "package.json"), "utf8"));
	assert.match(manifest.dependencies["@nanopi-package-test/target"], /^file:/);
	assert.match(manifest.dependencies["@nanopi-package-test/second"], /^file:/);
	smokeTestPnpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@nanopi-package-test/target" });
	smokeTestPnpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@nanopi-package-test/second" });

	const lockPath = join(consumerDirectory, "pnpm-lock.yaml");
	const lockContents = readFileSync(lockPath, "utf8");
	const localArtifactKey = /@nanopi-package-test\/target@file:.*target-[^\s:]+\.tgz/;
	const targetKey = lockContents.match(localArtifactKey)?.[0];
	assert.ok(targetKey, "consumer lockfile must reference the local target artifact");
	writeFileSync(lockPath, lockContents.replace(targetKey, "@nanopi-package-test/target@1.0.0"));
	assert.throws(
		() => smokeTestPnpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@nanopi-package-test/target" }),
		/did not resolve from a local artifact/,
	);
	writeFileSync(lockPath, lockContents);

	rmSync(join(consumerDirectory, "node_modules", "@nanopi-package-test", "target", "dist", "feature.js"));
	assert.throws(
		() => smokeTestPnpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@nanopi-package-test/target" }),
		/export \.\/feature does not exist/,
	);
});

test("installs a package as the only direct dependency", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	const unsupportedDirectory = join(root, "unsupported-consumer");
	assert.throws(
		() => wireConsumer({ artifactSet, consumerDirectory: unsupportedDirectory, packageManager: "yarn", packageNames: ["@nanopi-package-test/target"] }),
		/Unsupported package manager: yarn/,
	);
	assert.equal(existsSync(unsupportedDirectory), false);
	const consumerDirectory = join(root, "isolated-consumer");
	installConsumer({ artifactSet, directory: consumerDirectory, packageNames: ["@nanopi-package-test/target"] });
	const manifest = JSON.parse(readFileSync(join(consumerDirectory, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies), ["@nanopi-package-test/target"]);
	smokeTestPnpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@nanopi-package-test/target" });
	const installedManifestPath = join(consumerDirectory, "node_modules", "@nanopi-package-test", "target", "package.json");
	const installedManifestContents = readFileSync(installedManifestPath, "utf8");
	const installedManifest = JSON.parse(installedManifestContents);
	delete installedManifest.main;
	writeFileSync(installedManifestPath, JSON.stringify(installedManifest));
	assert.throws(
		() => smokeTestPnpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@nanopi-package-test/target" }),
		/Public nanopi package @nanopi-package-test\/target must declare a string main field/,
	);
	writeFileSync(installedManifestPath, installedManifestContents);
	const lockPath = join(consumerDirectory, "pnpm-lock.yaml");
	const lockContents = readFileSync(lockPath, "utf8");
	rmSync(lockPath);
	assert.throws(
		() => smokeTestPnpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@nanopi-package-test/target" }),
		/pnpm consumer smoke test requires pnpm-lock\.yaml/,
	);
	writeFileSync(lockPath, lockContents);
	writeFileSync(lockPath, "lockfileVersion:\n  - 9.0\n");
	assert.throws(
		() => smokeTestPnpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@nanopi-package-test/target" }),
		/Invalid pnpm lockfile: packages object is missing/,
	);
});

test("wires and installs a pnpm consumer without registry fallbacks", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	const consumerDirectory = join(root, "pnpm-consumer");
	mkdirSync(consumerDirectory);
	writeFileSync(join(consumerDirectory, "package.json"), '{"private":true,"type":"module"}\n');
	writeFileSync(join(consumerDirectory, "pnpm-workspace.yaml"), "# existing workspace comment\npackages: []\noverrides:\n  existing: 1.2.3\n");
	wireConsumer({
		artifactSet,
		consumerDirectory,
		packageManager: "pnpm",
		packageNames: ["@nanopi-package-test/target"],
	});

	const manifest = JSON.parse(readFileSync(join(consumerDirectory, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies), ["@nanopi-package-test/target"]);
	assert.equal(manifest.overrides, undefined);
	const workspaceContents = readFileSync(join(consumerDirectory, "pnpm-workspace.yaml"), "utf8");
	assert.match(workspaceContents, /^# existing workspace comment/m);
	const workspace = parse(workspaceContents);
	assert.equal(workspace.overrides.existing, "1.2.3");
	for (const artifact of artifactSet.packages) {
		assert.ok(workspace.overrides[artifact.name].endsWith(basename(artifact.tarballPath)), `${artifact.name} override must reference its artifact`);
	}

	const pnpmCli = fileURLToPath(new URL("../node_modules/pnpm/bin/pnpm.mjs", import.meta.url));
	execFileSync(process.execPath, [pnpmCli, "install", "--prod", "--ignore-scripts", "--offline"], {
		cwd: consumerDirectory,
		stdio: "pipe",
		timeout: 300_000,
	});
	const marker = execFileSync(process.execPath, ["--input-type=module", "--eval", 'import("@nanopi-package-test/target").then(({ marker }) => console.log(marker))'], {
		cwd: consumerDirectory,
		encoding: "utf8",
	});
	assert.equal(marker.trim(), "local artifact");
	const lockContents = readFileSync(join(consumerDirectory, "pnpm-lock.yaml"), "utf8");
	assert.doesNotMatch(lockContents, /https?:\/\//);
	for (const packageName of ["@nanopi-package-test/target", "@nanopi-package-test/shared"]) {
		assert.ok(lockContents.includes(basename(artifactSet.getPackage(packageName).tarballPath)), `${packageName} lock entry must reference its artifact`);
	}
});
