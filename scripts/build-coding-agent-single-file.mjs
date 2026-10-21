#!/usr/bin/env node
/**
 * Builds the single-file nanopi.js distribution.
 *
 * One self-contained ESM file, zero runtime dependencies (Node >= 22.19):
 * - the full CLI graph bundled by esbuild, including jiti and photon's JS
 *   glue (the wasm itself is a runtime sidecar, see below)
 * - package assets (export-html templates, webui, docs, examples,
 *   package.json) embedded as gzip+base64 and extracted to a versioned cache
 *   directory at startup by src/standalone/assets.ts
 * - builtin sidecars for flavors enabling `sidecar/*` (file contents embedded
 *   as gzip+base64 and installed to the agent bin directory with the same
 *   sha256 verification), plus a sidecar manifest pinning npm-registry
 *   tarball URLs plus per-file sha256 hashes for on-demand download fallback,
 *   both installed by src/utils/sidecars.ts
 *
 * Requires the workspace packages to be built first (pnpm run build).
 */

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import {
	loadBuildConfig,
	readProviderCatalogIds,
	resolveBuildFlavor,
	resolveBuiltinApiIds,
	resolveBuiltinProviderIds,
	validateFlavorModules,
	validateFlavorProviders,
} from "./buildconfig.mjs";
import {
	buildDefines,
	resolveBuildCommit,
	SINGLE_FILE_EXTERNAL_PACKAGES,
	SINGLE_FILE_BANNER,
	validateExternalImports,
} from "./esbuild-shared.mjs";
import { createApiStubPlugin, validateStubs } from "./build-apis.mjs";
import {
	createComponentStubPlugin,
	createLazyImportDropPlugin,
	resolveComponentSwitches,
	validateComponentStubExports,
} from "./build-components.mjs";
import { createModuleStubPlugin } from "./build-modules.mjs";
import { httpsProxyAgentNamedExportPlugin } from "./proxy-agent-plugin.mjs";
import { createToolStubPlugin, validateToolSet } from "./build-tools.mjs";
import { readBuiltinModuleNames, resolveModuleBundles } from "./module-registry.mjs";
import { OAUTH_FLOWS, oauthComponentName, validateOAuthFlowRegistry } from "./oauth-flows.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const codingAgentDistDir = join(codingAgentDir, "dist");
const aiDistDir = join(repoRoot, "packages", "ai", "dist");
const webuiDistDir = join(repoRoot, "packages", "webui", "dist");
const tuiNativeDir = join(repoRoot, "packages", "tui", "native");
const defaultOutput = join(codingAgentDir, "binaries", "nanopi.js");

// Build flavors (buildconfig.json) drop peripheral components from the
// embedded assets and, for OAuth flows, from the statically registered
// loaders (see the partial shim below).
const resolved = resolveBuildFlavor(repoRoot);
const { flavor, toolset, toolNames, providers, apis } = resolved;
// The single file never loads disk modules: it keeps jiti external so the
// artifact stays zero-dependency, so the component is off here whatever the
// flavor says.
const components = resolveComponentSwitches({ components: resolved.components, singleFile: true });
// A provider set that ships every catalog has no runtime filter; a set that
// ships none resolves to an empty list and the build keeps no built-in provider.
const builtinProviderIds = resolveBuiltinProviderIds(providers);
// A flavor that names an API set ships only those implementations: models.json
// can reference nothing else, and the other lazy clients stay out of the bundle.
const builtinApiIds = resolveBuiltinApiIds(apis);
validateOAuthFlowRegistry({ repoRoot, components });
// A tool set that names its tools drops the rest of the tool implementations
// from the bundle instead of only filtering them at runtime.
validateToolSet(toolNames);
// Every built-in module is a `module/<name>` component; a flavor can drop one,
// in which case its code stays out of the single file (see build-modules.mjs).
const buildConfig = loadBuildConfig(repoRoot);
validateFlavorModules(repoRoot, readBuiltinModuleNames(repoRoot));
validateFlavorProviders(repoRoot, readProviderCatalogIds(repoRoot), flavor);
const isComponentEnabled = (name) => components[name] !== false;

const outArgs = process.argv.slice(2);
const outIndex = outArgs.indexOf("--out");
const outputFilePath = outIndex !== -1 && outArgs[outIndex + 1] ? resolve(outArgs[outIndex + 1]) : defaultOutput;

const requireFromCodingAgent = createRequire(join(codingAgentDir, "package.json"));

// Optional native accelerators stay external: callers fall back to JavaScript
// when they are absent, which they always are in the single-file distribution.
const allowedExternalPackages = new Set(SINGLE_FILE_EXTERNAL_PACKAGES);

function fail(message) {
	throw new Error(message);
}

function sha256OfPath(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function collectFiles(rootDir, filter = () => true) {
	const files = [];
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === ".DS_Store") continue;
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(fullPath);
			} else if (entry.isFile() && filter(fullPath)) {
				files.push(fullPath);
			}
		}
	};
	visit(rootDir);
	return files;
}

function toPosix(path) {
	return path.replaceAll("\\", "/");
}

/**
 * Embedded package assets: everything config.ts path helpers resolve relative
 * to the package dir. Layout matches the npm package (dist/ plus root files)
 * so NANOPI_PACKAGE_DIR pointing at the extracted tree needs no special cases.
 */
function buildAssetsPayload() {
	const packageDirFiles = [
		join(codingAgentDir, "package.json"),
		join(codingAgentDir, "README.md"),
		join(codingAgentDir, "CHANGELOG.md"),
	];
	// [source tree, path inside the extracted package dir]
	const distTrees = [];
	if (isComponentEnabled("export-html")) {
		distTrees.push([join(codingAgentDistDir, "core", "export-html"), join("dist", "core", "export-html")]);
	}
	if (isComponentEnabled("webui")) {
		distTrees.push([webuiDistDir, join("dist", "webui")]);
	}
	const repoTrees = [];
	if (isComponentEnabled("docs")) repoTrees.push([join(codingAgentDir, "docs"), "docs"]);
	if (isComponentEnabled("examples")) repoTrees.push([join(codingAgentDir, "examples"), "examples"]);

	const archive = {};
	for (const filePath of packageDirFiles) {
		if (!existsSync(filePath)) fail(`Bundle asset is missing: ${relative(repoRoot, filePath)}. Build the workspace first.`);
		archive[toPosix(relative(codingAgentDir, filePath))] = readFileSync(filePath).toString("base64");
	}
	for (const [sourceRoot, relativeRoot] of [...distTrees, ...repoTrees]) {
		if (!existsSync(sourceRoot)) fail(`Bundle asset tree is missing: ${relative(repoRoot, sourceRoot)}`);
		for (const filePath of collectFiles(sourceRoot)) {
			archive[toPosix(join(relativeRoot, relative(sourceRoot, filePath)))] = readFileSync(filePath).toString("base64");
		}
	}

	const rawBytes = Object.keys(archive).length;
	const payload = gzipSync(Buffer.from(JSON.stringify(archive))).toString("base64");
	return { payload, rawBytes };
}

/**
 * Sidecar file collection, shared by the builtin payload and the download manifest.
 * Each entry carries the file content so flavors enabling `sidecar/*` can embed
 * it, while the manifest path only needs hashes and URLs for on-demand download.
 */
function collectSidecarFiles() {
	// Photon wasm: universal, one file.
	const photonEntry = requireFromCodingAgent.resolve("@silvia-odwyer/photon-node");
	const photonDir = dirname(photonEntry);
	const photonWasmPath = join(photonDir, "photon_rs_bg.wasm");
	if (!existsSync(photonWasmPath)) fail(`photon wasm not found next to ${photonEntry}`);
	const photonVersion = JSON.parse(readFileSync(join(photonDir, "package.json"), "utf8")).version;
	const photonContent = readFileSync(photonWasmPath);
	const photon = {
		info: {
			kind: "photon-wasm",
			tarPath: "package/photon_rs_bg.wasm",
			destPath: "photon/photon_rs_bg.wasm",
			sha256: sha256OfPath(photonWasmPath),
			bytes: photonContent.byteLength,
		},
		version: photonVersion,
		content: photonContent,
	};

	// TUI native prebuilds: one .node file per platform/arch.
	const tuiVersion = JSON.parse(readFileSync(join(repoRoot, "packages", "tui", "package.json"), "utf8")).version;
	const tuiFiles = [];
	for (const os of readdirSync(tuiNativeDir)) {
		const prebuildsRoot = join(tuiNativeDir, os, "prebuilds");
		if (!existsSync(prebuildsRoot)) continue;
		for (const platformArch of readdirSync(prebuildsRoot)) {
			const [platform, arch] = platformArch.split("-");
			const prebuildDir = join(prebuildsRoot, platformArch);
			for (const fileName of readdirSync(prebuildDir)) {
				if (!fileName.endsWith(".node")) continue;
				const filePath = join(prebuildDir, fileName);
				const content = readFileSync(filePath);
				tuiFiles.push({
					info: {
						kind: "tui-native",
						tarPath: `package/native/${os}/prebuilds/${platformArch}/${fileName}`,
						destPath: `native/tui/native/${os}/prebuilds/${platformArch}/${fileName}`,
						sha256: sha256OfPath(filePath),
						bytes: content.byteLength,
						os: platform,
						arch,
					},
					content,
				});
			}
		}
	}
	if (tuiFiles.length === 0) fail(`no TUI native prebuilds under ${relative(repoRoot, tuiNativeDir)}`);
	return { photon, photonVersion, tuiFiles, tuiVersion };
}

/**
 * Builtin sidecar payload: file contents for flavors enabling `sidecar/*`.
 * Packed as gzip+base64 like the package assets; the runtime installs the
 * platform-matching entries into the agent bin directory with the same
 * sha256 verification as downloads. Disabled components resolve to an empty
 * list and keep the download fallback.
 */
function buildBuiltinSidecars(collected) {
	const files = [];
	if (isComponentEnabled("sidecar/photon-wasm")) {
		files.push({ ...collected.photon.info, content: collected.photon.content.toString("base64") });
	}
	if (isComponentEnabled("sidecar/tui-native")) {
		for (const file of collected.tuiFiles) {
			files.push({ ...file.info, content: file.content.toString("base64") });
		}
	}
	return { payload: gzipSync(Buffer.from(JSON.stringify({ files }))).toString("base64"), count: files.length };
}

/** Sidecar manifest sources, pinned by per-file sha256. */
function buildSidecarManifest(collected) {
	const registry = "https://registry.npmjs.org";
	const npmTarballUrl = (name, version) => {
		const unscoped = name.startsWith("@") ? name.split("/")[1] : name;
		return `${registry}/${name}/-/${unscoped}-${version}.tgz`;
	};
	// The fork's workspace packages are not on the public npm registry, so the
	// TUI prebuilds ship as a release asset next to nanopi.js. Unreleased local
	// builds keep working: the download 404s and the optional accelerators
	// stay off (photon still comes from npm).
	const repositoryUrl = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8")).repository.url;
	const repository = repositoryUrl.replace(/^git\+https:\/\/github\.com\//, "").replace(/\.git$/, "");
	const githubTarballUrl = (version, name) =>
		`https://github.com/${repository}/releases/download/v${version}/${name}`;

	const { photon, photonVersion, tuiFiles, tuiVersion } = collected;
	return {
		sources: [
			{
				packageName: "@silvia-odwyer/photon-node",
				version: photonVersion,
				url: npmTarballUrl("@silvia-odwyer/photon-node", photonVersion),
				files: [photon.info],
			},
			{
				packageName: "@nanopi/pi-tui",
				version: tuiVersion,
				url: githubTarballUrl(tuiVersion, `nanopi-sidecars-${tuiVersion}.tgz`),
				// The tarball mirrors the agent bin directory layout.
				files: tuiFiles.map((file) => ({ ...file.info, tarPath: file.info.destPath })),
			},
		],
	};
}

const entryPoint = join(codingAgentDistDir, "standalone", "cli.js");
const requiredInputs = [entryPoint, join(codingAgentDistDir, "cli.js")];
if (isComponentEnabled("webui")) requiredInputs.push(join(webuiDistDir, "index.html"));
for (const required of requiredInputs) {
	if (!existsSync(required)) {
		fail(`Bundle input is missing: ${relative(repoRoot, required)}. Build the workspace packages first.`);
	}
}

const { payload: assetsPayload, rawBytes: assetCount } = buildAssetsPayload();
const collectedSidecars = collectSidecarFiles();
const sidecarManifest = buildSidecarManifest(collectedSidecars);
const builtinSidecars = buildBuiltinSidecars(collectedSidecars);
const version = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8")).version;
// Same contract as the npm bundle: the single-file artifact has no .git directory
// at runtime, so the commit is baked in at build time.
const buildCommit = resolveBuildCommit(repoRoot);

// OAuth flows disabled by the flavor must not be statically imported either:
// alias the bundled-oauth registration module to a shim registering only the
// enabled flows. load.ts's component guard fails disabled flows cleanly.
const enabledFlows = OAUTH_FLOWS.filter((flow) => isComponentEnabled(oauthComponentName(flow)));
const moduleStubDir = mkdtempSync(join(tmpdir(), "nanopi-module-stubs-"));
const { plugin: moduleStubPlugin, disabled: disabledModules } = createModuleStubPlugin({
	stubDir: moduleStubDir,
	modules: resolveModuleBundles(repoRoot, buildConfig),
	components,
});
const toolStubDir = mkdtempSync(join(tmpdir(), "nanopi-tool-stubs-"));
const { plugin: toolStubPlugin, excluded: excludedTools } = createToolStubPlugin({
	stubDir: toolStubDir,
	toolsSrcDir: join(codingAgentDir, "src", "core", "tools"),
	toolNames,
});
// Components whose module is swapped at resolve time instead of folded at
// runtime: the component's data is a static import, so a dead branch keeps it.
validateComponentStubExports(codingAgentDir);
const { plugin: componentStubPlugin, disabledModules: disabledComponentModules } = createComponentStubPlugin({
	components,
	codingAgentDir,
});
// API implementations and provider catalogs outside the flavor's sets are swapped
// at resolve time: the runtime filters that used to guard them left the lazy
// `import()` of every client SDK and every static catalog import in the graph,
// which is what kept `@google/genai`, the AWS SDK and ~1 MiB of model data in a
// single-endpoint build.
const aiDir = join(repoRoot, "packages", "ai");
validateStubs(aiDir);
const { plugin: apiStubPlugin, disabledApis, disabledProviders } = createApiStubPlugin({
	aiDir,
	apis,
	builtinProviderIds,
});
const plugins = [
	apiStubPlugin,
	componentStubPlugin,
	createLazyImportDropPlugin({ components }),
	moduleStubPlugin,
	toolStubPlugin,
	httpsProxyAgentNamedExportPlugin(repoRoot),
];
let shimDir;
if (enabledFlows.length < OAUTH_FLOWS.length) {
	shimDir = mkdtempSync(join(tmpdir(), "nanopi-bundled-oauth-"));
	const shimPath = join(shimDir, "bundled-oauth.mjs");
	const shimLines = [
		`import { registerBundledOAuthFlowLoaders } from ${JSON.stringify(join(aiDistDir, "auth", "oauth", "load.js"))};`,
	];
	for (const flow of enabledFlows) {
		shimLines.push(
			`import { ${flow.exportName} } from ${JSON.stringify(join(aiDistDir, "auth", "oauth", `${flow.module}.js`))};`,
		);
	}
	shimLines.push("registerBundledOAuthFlowLoaders({");
	for (const flow of enabledFlows) shimLines.push(`\t${flow.loader}: () => ${flow.exportName},`);
	shimLines.push("});");
	shimLines.push("export function registerBundledOAuthFlows() {}");
	writeFileSync(shimPath, `${shimLines.join("\n")}\n`);
	plugins.unshift({
		name: "partial-bundled-oauth",
		setup(build) {
			build.onResolve({ filter: /^@nanopi\/pi-ai\/bundled-oauth$/ }, () => ({ path: shimPath }));
		},
	});
}

let result;
// NANOPI_BUILD_METAFILE_DIR: diagnostics hook for size work. When set, the build
// writes its esbuild metafile next to the given directory so per-package and
// per-dependency byte counts can be attributed without another build variant.
const metafileOutDir = process.env.NANOPI_BUILD_METAFILE_DIR;
try {
	result = await build({
		absWorkingDir: repoRoot,
		banner: SINGLE_FILE_BANNER,
		bundle: true,
		define: {
			...buildDefines({ flavor, components, toolset, toolNames, builtinProviderIds, builtinApiIds, buildCommit }),
			// Single-file specifics: the embedded assets and sidecars, the version
			// of the artifact, and the flag that tells the runtime it is the
			// standalone build.
			NANOPI_SINGLE_FILE: "true",
			NANOPI_SINGLE_FILE_ASSETS: JSON.stringify(assetsPayload),
			NANOPI_SINGLE_FILE_VERSION: JSON.stringify(version),
			NANOPI_SIDECARS: JSON.stringify(JSON.stringify(sidecarManifest)),
			NANOPI_BUILTIN_SIDECARS: JSON.stringify(builtinSidecars.payload),
		},
		entryPoints: [entryPoint],
		external: Array.from(allowedExternalPackages),
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifyIdentifiers: true,
		minifySyntax: true,
		minifyWhitespace: true,
		outfile: outputFilePath,
		platform: "node",
		plugins,
		sourcemap: false,
		splitting: false,
		target: "node22.19",
		// Do not apply the monorepo's source-oriented path aliases while bundling
		// compiled output; resolve the same package entries as an installed package.
		tsconfigRaw: { compilerOptions: {} },
	});
} finally {
	if (shimDir) rmSync(shimDir, { recursive: true, force: true });
	rmSync(moduleStubDir, { recursive: true, force: true });
	rmSync(toolStubDir, { recursive: true, force: true });
}

if (metafileOutDir) {
	mkdirSync(metafileOutDir, { recursive: true });
	writeFileSync(join(metafileOutDir, `${flavor}.metafile.json`), JSON.stringify(result.metafile));
	const meta = result.metafile;
	const byPackage = new Map();
	for (const [input, info] of Object.entries(meta.inputs)) {
		const match = /node_modules\/\.pnpm\/([^/]+)\//.exec(input) ?? /node_modules\/([^/]+)\//.exec(input);
		const key = match ? match[1] : input.startsWith("packages/") ? input.split("/").slice(0, 2).join("/") : "(repo)";
		byPackage.set(key, (byPackage.get(key) ?? 0) + (info.bytes ?? 0));
	}
	const top = [...byPackage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
	for (const [name, bytes] of top) console.log(`  input ${name}: ${(bytes / 1024).toFixed(0)} KiB`);
}

validateExternalImports([result.metafile], allowedExternalPackages);

// esbuild hoists the entry's shebang to the first line; verify it survived.
const bundlePath = resolve(repoRoot, Object.keys(result.metafile.outputs)[0]);
const bundleSource = readFileSync(bundlePath, "utf8");
if (!bundleSource.startsWith("#!")) fail("bundle is missing its shebang line");
chmodSync(outputFilePath, 0o755);

const mib = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
const outputBytes = statSync(outputFilePath).size;
const sidecarCount = sidecarManifest.sources.reduce((total, source) => total + source.files.length, 0);
console.log(
	`Built ${relative(repoRoot, outputFilePath)} (${mib(outputBytes)} MiB, flavor: ${flavor}, toolset: ${toolset}` +
		(excludedTools.length > 0 ? `, excluded tools: ${excludedTools.join(", ")}` : "") +
		(disabledModules.length > 0 ? `, excluded modules: ${disabledModules.join(", ")}` : "") +
		(disabledComponentModules.length > 0 ? `, stubbed: ${disabledComponentModules.join(", ")}` : "") +
		(disabledApis.length > 0 ? `, stubbed APIs: ${disabledApis.length}` : "") +
		(disabledProviders.length > 0 ? `, stubbed catalogs: ${disabledProviders.length}` : "") +
		")",
);
console.log(
	`  embedded assets: ${assetCount} files, ${mib(assetsPayload.length * 0.75)} MiB packed; sidecar manifest: ${sidecarCount} files; builtin sidecars: ${builtinSidecars.count} files (${mib(builtinSidecars.payload.length * 0.75)} MiB packed)`,
);

// Emit the TUI sidecar tarball referenced by the manifest as a release asset.
// Layout inside the tarball equals the agent bin directory layout.
const tuiSource = sidecarManifest.sources.find((source) => source.packageName === "@nanopi/pi-tui");
const sidecarArchivePath = join(dirname(outputFilePath), `nanopi-sidecars-${tuiSource.version}.tgz`);
const sidecarStaging = join(dirname(outputFilePath), `.sidecar-staging-${process.pid}`);
rmSync(sidecarStaging, { recursive: true, force: true });
try {
	for (const file of tuiSource.files) {
		const sourceRoot = join(tuiNativeDir, file.os, "prebuilds", `${file.os}-${file.arch}`);
		const staged = join(sidecarStaging, file.destPath);
		mkdirSync(dirname(staged), { recursive: true });
		cpSync(join(sourceRoot, basename(file.tarPath)), staged);
	}
	execFileSync("tar", ["-czf", sidecarArchivePath, "-C", sidecarStaging, "native"], { stdio: "pipe" });
} finally {
	rmSync(sidecarStaging, { recursive: true, force: true });
}
console.log(`Built ${relative(repoRoot, sidecarArchivePath)} (${mib(statSync(sidecarArchivePath).size)} MiB)`);
