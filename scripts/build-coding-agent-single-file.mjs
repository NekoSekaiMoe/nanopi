#!/usr/bin/env node
/**
 * Builds the single-file nanopi.js distribution.
 *
 * One self-contained ESM file, zero runtime dependencies (Node >= 22.19):
 * - the full CLI graph bundled by esbuild, including jiti and photon's JS
 *   glue (the wasm itself is a runtime sidecar, see below)
 * - package assets (themes, export-html templates, webui, docs, examples,
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
import { createRequire, isBuiltin } from "node:module";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { resolveBuildFlavor } from "./buildconfig.mjs";
import { resolveBundledExtras } from "./extras.mjs";
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
const { flavor, components } = resolveBuildFlavor(repoRoot);
validateOAuthFlowRegistry({ repoRoot, components });
const isComponentEnabled = (name) => components[name] !== false;

const outArgs = process.argv.slice(2);
const outIndex = outArgs.indexOf("--out");
const outputFilePath = outIndex !== -1 && outArgs[outIndex + 1] ? resolve(outArgs[outIndex + 1]) : defaultOutput;

const requireFromCodingAgent = createRequire(join(codingAgentDir, "package.json"));

const banner = {
	js: `import { createRequire as __piCreateRequire, enableCompileCache } from "node:module";
const require = __piCreateRequire(import.meta.url);
const __filename = import.meta.filename;
const __dirname = require("node:path").dirname(__filename);
try { enableCompileCache(); } catch {}`,
};

// Optional native accelerators stay external: callers fall back to JavaScript
// when they are absent, which they always are in the single-file distribution.
const allowedExternalPackages = new Set(["bufferutil", "utf-8-validate", "kerberos", "supports-color"]);

const httpsProxyAgentNamedExportPlugin = {
	name: "https-proxy-agent-named-export",
	setup(build) {
		const resolveFromImporter = createRequire(import.meta.url).resolve;
		build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
			if (args.kind !== "dynamic-import") return undefined;
			// Resolve from the importing module so pnpm's isolated layout serves
			// the version the importer depends on (see build-coding-agent-bundle.mjs).
			const fromDir = args.importer && args.importer !== "<stdin>" ? dirname(args.importer) : repoRoot;
			const resolved = resolveFromImporter("https-proxy-agent", { paths: [fromDir] });
			return {
				namespace: "https-proxy-agent-named-export",
				path: resolved,
			};
		});
		build.onLoad(
			{
				filter: /.*/,
				namespace: "https-proxy-agent-named-export",
			},
			(args) => ({
				contents: `export { HttpsProxyAgent } from ${JSON.stringify(args.path)};`,
				loader: "js",
				resolveDir: dirname(args.path),
			}),
		);
	},
};

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
	const distTrees = [
		[join(codingAgentDistDir, "modes", "interactive", "theme"), join("dist", "modes", "interactive", "theme")],
	];
	if (isComponentEnabled("export-html")) {
		distTrees.push([join(codingAgentDistDir, "core", "export-html"), join("dist", "core", "export-html")]);
	}
	if (isComponentEnabled("webui")) {
		distTrees.push([webuiDistDir, join("dist", "webui")]);
	}
	const repoTrees = [];
	if (isComponentEnabled("docs")) repoTrees.push([join(codingAgentDir, "docs"), "docs"]);
	if (isComponentEnabled("examples")) repoTrees.push([join(codingAgentDir, "examples"), "examples"]);
	for (const extra of resolveBundledExtras({ repoRoot, components })) {
		distTrees.push([extra.sourceDir, join("dist", "extras", extra.name)]);
	}

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

// OAuth flows disabled by the flavor must not be statically imported either:
// alias the bundled-oauth registration module to a shim registering only the
// enabled flows. load.ts's component guard fails disabled flows cleanly.
const enabledFlows = OAUTH_FLOWS.filter((flow) => isComponentEnabled(oauthComponentName(flow)));
const plugins = [httpsProxyAgentNamedExportPlugin];
if (components["modes"] === false) {
	// Same inert-stub alias as the bundle build: the modes module stays out of
	// the single-file artifact entirely.
	plugins.unshift({
		name: "pi-extra-disabled-stub",
		setup(build) {
			build.onResolve({ filter: /^@nanopi\/pi-extra$/ }, () => ({
				path: join(repoRoot, "scripts", "pi-extra-disabled-stub.mjs"),
			}));
		},
	});
}
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
try {
	result = await build({
		absWorkingDir: repoRoot,
		banner,
		bundle: true,
		define: {
			NANOPI_BUNDLED_NODE: "true",
			NANOPI_SINGLE_FILE: "true",
			NANOPI_SINGLE_FILE_ASSETS: JSON.stringify(assetsPayload),
			NANOPI_SINGLE_FILE_VERSION: JSON.stringify(version),
			NANOPI_SIDECARS: JSON.stringify(JSON.stringify(sidecarManifest)),
			NANOPI_BUILTIN_SIDECARS: JSON.stringify(builtinSidecars.payload),
			NANOPI_BUILD_COMPONENTS: JSON.stringify(components),
			NANOPI_BUILD_FLAVOR: JSON.stringify(flavor),
		},
		entryPoints: [entryPoint],
		external: Array.from(allowedExternalPackages),
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
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
}

const unexpected = new Set();
for (const input of Object.values(result.metafile.inputs)) {
	for (const imported of input.imports) {
		// <define:name> entries are esbuild's object-valued defines, not imports.
		if (
			!imported.external ||
			imported.path.startsWith("<define:") ||
			isBuiltin(imported.path) ||
			allowedExternalPackages.has(imported.path)
		) {
			continue;
		}
		unexpected.add(imported.path);
	}
}
if (unexpected.size > 0) {
	fail(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
}

// esbuild hoists the entry's shebang to the first line; verify it survived.
const bundlePath = resolve(repoRoot, Object.keys(result.metafile.outputs)[0]);
const bundleSource = readFileSync(bundlePath, "utf8");
if (!bundleSource.startsWith("#!")) fail("bundle is missing its shebang line");
chmodSync(outputFilePath, 0o755);

const mib = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
const outputBytes = statSync(outputFilePath).size;
const sidecarCount = sidecarManifest.sources.reduce((total, source) => total + source.files.length, 0);
console.log(`Built ${relative(repoRoot, outputFilePath)} (${mib(outputBytes)} MiB, flavor: ${flavor})`);
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
