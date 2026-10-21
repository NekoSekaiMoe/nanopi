#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
	BUNDLE_EXTERNAL_PACKAGES,
	buildDefines,
	NODE_ESM_BANNER,
	resolveBuildCommit,
	validateExternalImports,
} from "./esbuild-shared.mjs";
import {
	loadBuildConfig,
	readProviderCatalogIds,
	resolveBuildFlavor,
	resolveBuiltinApiIds,
	resolveBuiltinProviderIds,
	validateFlavorModules,
	validateFlavorProviders,
} from "./buildconfig.mjs";
import { httpsProxyAgentNamedExportPlugin } from "./proxy-agent-plugin.mjs";
import { createModuleStubPlugin } from "./build-modules.mjs";
import { createToolStubPlugin, validateToolSet } from "./build-tools.mjs";
import { readBuiltinModuleNames, resolveModuleBundles } from "./module-registry.mjs";
import { OAUTH_FLOWS, oauthComponentName, validateOAuthFlowRegistry } from "./oauth-flows.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const aiDistDir = join(repoRoot, "packages", "ai", "dist");
const codingAgentDistDir = join(codingAgentDir, "dist");
const bundleDir = join(codingAgentDistDir, "bundle");

// Build flavors (buildconfig.json) control peripheral components. The
// resolved map is injected as a define so the runtime reports disabled
// components cleanly (see isBuildComponentEnabled in the packages).
const { flavor, components, toolset, toolNames, providers, apis } = resolveBuildFlavor(repoRoot);
// A provider set that ships every catalog has no runtime filter; a set that
// ships none resolves to an empty list and the build keeps no built-in provider.
const builtinProviderIds = resolveBuiltinProviderIds(providers);
// A flavor that names an API set ships only those implementations: models.json
// can reference nothing else, and the other lazy clients stay out of the bundle.
const builtinApiIds = resolveBuiltinApiIds(apis);
validateOAuthFlowRegistry({ repoRoot, components });
validateToolSet(toolNames);
// Every built-in module is a `module/<name>` component; validateFlavorModules
// fails the build when the module list and buildconfig.json disagree.
const buildConfig = loadBuildConfig(repoRoot);
validateFlavorModules(repoRoot, readBuiltinModuleNames(repoRoot));
// Provider sets name built-in catalogs; validateFlavorProviders fails the build
// when a set and the generated catalogs in packages/ai disagree.
validateFlavorProviders(repoRoot, readProviderCatalogIds(repoRoot), flavor);
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

const buildCommit = resolveBuildCommit(repoRoot);
const allowedExternalPackages = new Set(BUNDLE_EXTERNAL_PACKAGES);

const lazyJitiPlugin = {
	name: "lazy-jiti-transform",
	setup(build) {
		build.onResolve({ filter: /^jiti\/static$/ }, () => ({
			namespace: "lazy-jiti",
			path: "jiti/static",
		}));
		build.onLoad({ filter: /.*/, namespace: "lazy-jiti" }, () => ({
			contents: `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let createJitiImpl;

export function createJiti(...args) {
	createJitiImpl ??= require("jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			loader: "js",
		}));
	},
};

function commonBuildOptions() {
	return {
		absWorkingDir: repoRoot,
		banner: NODE_ESM_BANNER,
		bundle: true,
		define: buildDefines({
			flavor,
			components,
			toolset,
			toolNames,
			builtinProviderIds,
			builtinApiIds,
			buildCommit,
		}),
		external: ["@silvia-odwyer/photon-node"],
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifyIdentifiers: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		// The source uses jiti/static so Bun embeds its Babel transform. The Node
		// package replaces it with a synchronous lazy require so jiti loads only
		// when importing an extension; Babel remains deferred until a cache miss
		// needs transformation.
		plugins: [
			moduleStubPlugin,
			toolStubPlugin,
			lazyJitiPlugin,
			httpsProxyAgentNamedExportPlugin(repoRoot),
		],
		sourcemap: false,
		target: "node22.19",
		// Do not apply the monorepo's source-oriented path aliases while bundling
		// compiled output. Release builds must resolve the same package entries as
		// an installed npm package.
		tsconfigRaw: { compilerOptions: {} },
	};
}

function findContainingOutput(metafile, inputSuffix) {
	const normalizedSuffix = inputSuffix.replaceAll("\\", "/");
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (Object.keys(output.inputs).some((inputPath) => inputPath.replaceAll("\\", "/").endsWith(normalizedSuffix))) {
			return resolve(repoRoot, outputPath);
		}
	}
	throw new Error(`Could not locate bundled output containing ${inputSuffix}`);
}

function outputBytes(metafiles) {
	return metafiles.reduce(
		(total, metafile) => total + Object.values(metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0),
		0,
	);
}

for (const entry of [
	join(codingAgentDistDir, "cli.js"),
	join(codingAgentDistDir, "index.js"),
	join(codingAgentDistDir, "rpc-entry.js"),
	join(codingAgentDistDir, "utils", "image-resize-worker.js"),
	join(aiDistDir, "api", "bedrock-converse-stream.js"),
	join(aiDistDir, "auth", "oauth", "anthropic.js"),
]) {
	if (!existsSync(entry)) {
		throw new Error(`Bundle input is missing: ${relative(repoRoot, entry)}. Build the workspace packages first.`);
	}
}

rmSync(bundleDir, { force: true, recursive: true });
mkdirSync(bundleDir, { recursive: true });

const mainResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		"cli-runtime": join(codingAgentDistDir, "cli.js"),
		index: join(codingAgentDistDir, "index.js"),
		"rpc-entry": join(codingAgentDistDir, "rpc-entry.js"),
	},
	outdir: bundleDir,
	chunkNames: "chunks/[name]-[hash]",
	splitting: true,
});

const bedrockLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/api/bedrock-converse-stream.lazy.js");
const oauthLoaderOutput = findContainingOutput(mainResult.metafile, "packages/ai/dist/auth/oauth/load.js");
const imageResizeOutput = findContainingOutput(mainResult.metafile, "packages/coding-agent/dist/utils/image-resize.js");
const configOutput = findContainingOutput(mainResult.metafile, "packages/coding-agent/dist/config.js");
if (dirname(bedrockLoaderOutput) !== dirname(oauthLoaderOutput)) {
	throw new Error("Bedrock and OAuth lazy loaders were emitted into different directories");
}

// These implementations are reached through variable-specifier imports or a
// worker URL, so the main bundle cannot follow them. Emit one self-contained
// file per implementation beside the code that resolves it.
const lazyEntryPoints = {
	"bedrock-converse-stream": join(aiDistDir, "api", "bedrock-converse-stream.js"),
	"image-resize-worker": join(codingAgentDistDir, "utils", "image-resize-worker.js"),
};

// OAuth flows are lazy entries too, but a flavor may exclude them. A missing
// entry is safe: load.ts checks the injected component map before importing
// and fails the flow with a clear "not included in this build" error.
// validateOAuthFlowRegistry keeps this list in sync with load.ts.
const excludedFlows = [];
for (const flow of OAUTH_FLOWS) {
	if (components[oauthComponentName(flow)] === false) {
		excludedFlows.push(flow.module);
		continue;
	}
	lazyEntryPoints[flow.module] = join(aiDistDir, "auth", "oauth", `${flow.module}.js`);
}

const lazyResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: lazyEntryPoints,
	outdir: dirname(bedrockLoaderOutput),
	splitting: false,
});

const imageResizeWorkerOutput = resolve(dirname(bedrockLoaderOutput), "image-resize-worker.js");
if (dirname(imageResizeOutput) !== dirname(imageResizeWorkerOutput)) {
	throw new Error("Image resize implementation and worker were emitted into different directories");
}
const metafiles = [mainResult.metafile, lazyResult.metafile];
validateExternalImports(metafiles, allowedExternalPackages);
const cliLauncher = `#!/usr/bin/env node
import { createRequire, enableCompileCache } from "node:module";

enableCompileCache();
createRequire(import.meta.url)("./cli-runtime.js");
`;
writeFileSync(join(bundleDir, "cli.js"), cliLauncher);
chmodSync(join(bundleDir, "cli.js"), 0o755);
chmodSync(join(bundleDir, "rpc-entry.js"), 0o755);

rmSync(moduleStubDir, { force: true, recursive: true });
rmSync(toolStubDir, { force: true, recursive: true });

const files = new Set(metafiles.flatMap((metafile) => Object.keys(metafile.outputs))).size + 1;
const mib = (outputBytes(metafiles) + cliLauncher.length) / (1024 * 1024);
console.log(
	`Built ${relative(repoRoot, bundleDir)} (${files} files, ${mib.toFixed(1)} MiB, flavor: ${flavor}, toolset: ${toolset}` +
		(excludedFlows.length > 0 ? `, excluded OAuth: ${excludedFlows.join(", ")}` : "") +
		(excludedTools.length > 0 ? `, excluded tools: ${excludedTools.join(", ")}` : "") +
		(disabledModules.length > 0 ? `, excluded modules: ${disabledModules.join(", ")}` : "") +
		")",
);
