/**
 * esbuild wiring shared by the two coding-agent bundle scripts:
 * build-coding-agent-bundle.mjs (the npm package) and
 * build-coding-agent-single-file.mjs (the standalone binary).
 *
 * Both builds have to agree on what the runtime reads back (the buildconfig.json
 * flavors and the build commit), on which packages stay external, and on which
 * external imports the produced graph may contain. They used to carry a copy of
 * each, so a define added to one build left the other on its default value with
 * a perfectly successful build.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join } from "node:path";

/** Node banner: the bundle is ESM but the dependency graph may call `require`. */
export const NODE_ESM_BANNER = {
	js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
};

/** Node banner plus the compile-cache opt-in, for the standalone single file. */
export const SINGLE_FILE_BANNER = {
	js: `import { createRequire as __piCreateRequire, enableCompileCache } from "node:module";
const require = __piCreateRequire(import.meta.url);
const __filename = import.meta.filename;
const __dirname = require("node:path").dirname(__filename);
try { enableCompileCache(); } catch {}`,
};

/**
 * Optional native accelerators and debug helpers. They stay external in both
 * builds: every caller falls back to JavaScript (or to a plain output) when the
 * package is absent, and absence is the normal case for the single file.
 */
export const OPTIONAL_EXTERNAL_PACKAGES = ["bufferutil", "utf-8-validate", "kerberos", "supports-color"];

/** Packages the npm bundle keeps external because it ships them as dependencies. */
export const BUNDLE_EXTERNAL_PACKAGES = ["@silvia-odwyer/photon-node", "jiti", ...OPTIONAL_EXTERNAL_PACKAGES];

/** Packages the single file keeps external because nothing can be installed at runtime. */
export const SINGLE_FILE_EXTERNAL_PACKAGES = [...OPTIONAL_EXTERNAL_PACKAGES];

/**
 * Commit the bundle was built from, baked into the NANOPI_BUILD_COMMIT define.
 * `core/build-version.ts` prefers the define over spawning git at runtime, so
 * the version a user sees matches the source they can inspect. Archives built
 * by CI carry no .git directory, so a missing repository degrades to "".
 */
export function resolveBuildCommit(repoRoot) {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "";
	}
}

/**
 * The esbuild define map both builds inject. Every entry is a value the runtime
 * reads back through a `declare const NANOPI_*` in the packages' sources, so
 * passing a different set to the two builds is the failure this function
 * exists to prevent.
 *
 * @param {{ flavor: string, components: Record<string, boolean | string>, toolset: string, toolNames: readonly string[] | undefined, builtinProviderIds: readonly string[] | undefined, builtinApiIds: readonly string[], buildCommit: string }} input
 * @returns {Record<string, string>}
 */
export function buildDefines({
	flavor,
	components,
	toolset,
	toolNames,
	builtinProviderIds,
	builtinApiIds,
	buildCommit,
}) {
	return {
		NANOPI_BUNDLED_NODE: "true",
		NANOPI_BUILD_COMMIT: JSON.stringify(buildCommit),
		NANOPI_BUILD_COMPONENTS: JSON.stringify(components),
		NANOPI_BUILD_FLAVOR: JSON.stringify(flavor),
		NANOPI_BUILD_TOOLSET: JSON.stringify(toolset),
		// A full provider set arrives as undefined (meaning "every catalog");
		// `"undefined"` tells the runtime the same thing as an absent define, and
		// esbuild rejects a define whose value is undefined.
		NANOPI_BUILD_PROVIDERS: JSON.stringify(builtinProviderIds) ?? "undefined",
		NANOPI_BUILD_APIS: JSON.stringify(builtinApiIds),
		// esbuild rejects an undefined define value, so a tool set that names no
		// tools injects the empty list the runtime reads as "every tool".
		NANOPI_BUILD_TOOLS: JSON.stringify(toolNames ?? []),
	};
}

/**
 * Rejects external imports the build does not expect. A leftover external
 * import is a dependency that resolved to a bare specifier at runtime, which
 * works in the repository and fails in the published package.
 */
export function validateExternalImports(metafiles, allowedExternalPackages) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (
					!imported.external ||
					// esbuild reports references to object-valued defines as pseudo
					// imports (<define:name>); they are build-time substitutions.
					imported.path.startsWith("<define:") ||
					isBuiltin(imported.path) ||
					allowedExternalPackages.has(imported.path)
				) {
					continue;
				}
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

/** Wraps a plugin list so an empty one still satisfies esbuild's `plugins` option. */
export function inertPlugin(name) {
	return { name, setup() {} };
}

/** A plugin that rewrites `from` into a generated module body, in its own namespace. */
export function generatedModulePlugin({ name, filter, namespace, contents }) {
	return {
		name,
		setup(build) {
			build.onResolve({ filter }, () => ({ path: namespace, namespace }));
			build.onLoad({ filter: /.*/, namespace }, () => ({ contents, loader: "js", resolveDir: process.cwd() }));
		},
	};
}

/**
 * Resolves the coding-agent's own package name to its compiled entry point.
 *
 * The bundled modules inside `packages/coding-agent/src/extras` import values
 * (`DynamicBorder`, `getMarkdownTheme`) from `@nanopi/pi-coding-agent` — the
 * public SDK surface — instead of reaching into `src/`. That is an ordinary
 * self-reference, and Node resolves it through the package's `exports` map.
 * esbuild does the same, but only when the package is reachable on disk under
 * its own name: `packages/coding-agent/node_modules/@nanopi/pi-coding-agent`
 * does not exist (pnpm links a package into its *dependents*, never into
 * itself), so on a fresh checkout the import falls through to
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` — the package.json is found, the `dist`
 * files the `exports` map points at are not, and esbuild reports
 * "Could not resolve".
 *
 * Resolving the specifier explicitly keeps the build independent of how the
 * workspace happens to be linked: the entry point is `dist/index.js` in both
 * builds, so the bundle stays one copy of the package instead of pulling a
 * second copy (or a second `dist`) into the graph.
 *
 * Only the exact package name is claimed; `@nanopi/pi-coding-agent/rpc-entry`
 * and every other subpath keep esbuild's default resolution.
 *
 * @param {{ packageName: string, packageDir: string }} options
 * @returns {import("esbuild").Plugin}
 */
export function selfReferencePlugin({ packageName, packageDir }) {
	const filter = new RegExp(`^${packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
	const entry = join(packageDir, "dist", "index.js");
	return {
		name: "self-reference",
		setup(build) {
			build.onResolve({ filter }, (args) => {
				if (args.path !== packageName) return undefined;
				if (!existsSync(entry)) {
					throw new Error(
						`${packageName} resolved to ${entry}, which does not exist. Build the workspace packages first.`,
					);
				}
				return { path: entry };
			});
		},
	};
}
