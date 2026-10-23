/**
 * esbuild wiring for the `module/<name>` buildconfig.json components.
 *
 * The coding-agent registers its built-in modules eagerly (see
 * packages/coding-agent/src/modules/index.ts), so a flavor that drops a module
 * has to keep its code out of the bundle. Two pieces of work:
 *
 * - `specifierFor(packageDir, path)` turns a source path in buildconfig.json
 *   into the specifier the build has to intercept (`../extras/todo-lite/index.ts`).
 *   buildconfig.json lists those paths in its top-level `moduleBundles`, and
 *   validateFlavorModules() cross-checks them against the module names.
 * - `moduleStubPlugin` aliases the disabled ones to a generated file exporting
 *   an inert factory. The registry still lists the module, `enabledModules()`
 *   filters it out at runtime, and the module's own code never reaches the
 *   bundle (`splitting: false` means no shared chunk can pull it back in).
 *
 * The stubs are written to a temp directory because esbuild resolves plugin
 * paths on disk, and they are cleaned up by the caller.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { MODULE_COMPONENT_PREFIX } from "./buildconfig.mjs";

/**
 * Import specifier esbuild sees for a built module entry. The bundle is built
 * from compiled output, so a source path becomes its `.js` sibling, spelled
 * relative to an importer `importerDepth` directories below the package src
 * root. Returns undefined for a module outside the coding-agent package (the
 * workspace package `@nanopi/pi-extra`), whose imports are package specifiers.
 */
export function specifierFor(codingAgentSrcDir, absolutePath, importerDepth = 1) {
	const relativePath = relative(codingAgentSrcDir, absolutePath).replaceAll("\\", "/");
	if (!relativePath.endsWith(".ts")) return undefined;
	const compiled = `${relativePath.slice(0, -3)}.js`;
	// The modules barrel sits one directory below src, so its imports read
	// `../extras/x/index.js`; an importer at the src root writes
	// `./extras/x/index.js`. Both are the same file, so both get a stub.
	return `${"../".repeat(importerDepth)}${compiled}`;
}

/**
 * Component name for a module, and the reverse lookup over a resolved map.
 */
export function moduleComponentName(name) {
	return `${MODULE_COMPONENT_PREFIX}${name}`;
}

/**
 * Builds the plugin plus the list of disabled modules.
 *
 * @param {{ stubDir: string, modules: ReadonlyArray<{ name: string, specifiers: readonly string[], exportNames?: readonly string[] }>, components: Record<string, boolean | string> }} options
 * @returns {{ plugin: import("esbuild").Plugin, disabled: string[] }}
 */
export function createModuleStubPlugin({ stubDir, modules, components }) {
	const disabled = modules.filter((module) => components[moduleComponentName(module.name)] === false);
	const bySpecifier = new Map(
		disabled.flatMap((module) => module.specifiers.map((specifier) => [specifier, module.name])),
	);
	if (disabled.length === 0) return { plugin: inertPlugin(), disabled: [] };

	mkdirSync(stubDir, { recursive: true });
	const paths = new Map();
	disabled.forEach((module, index) => {
		const file = join(stubDir, `module-${index}.mjs`);
		paths.set(module.name, file);
		const header =
			`// Inert stub for the "${module.name}" built-in module: this build flavor\n` +
			`// excludes it (buildconfig.json "${moduleComponentName(module.name)}").\n`;
		// The registry keeps the module listed so `--modules` still parses; the
		// stub registers nothing, and enabledModules() filters it out. A module
		// outside the coding-agent package also has a default export to keep
		// (pi-extra's `extraBridge`), so `exportNames` names what to stand in for.
		const named = (module.exportNames ?? []).map((name) => `export const ${name} = {};\n`).join("");
		writeFileSync(file, `${header}export default function noopModule() {}\n${named}`);
	});

	return {
		plugin: {
			name: "builtin-module-stubs",
			setup(build) {
				// esbuild reports the import exactly as the importer wrote it, which is
				// the path buildconfig.json names in `moduleBundles`.
				build.onResolve({ filter: /.*/ }, (args) => {
					const name = bySpecifier.get(args.path);
					return name === undefined ? undefined : { path: paths.get(name) };
				});
			},
		},
		disabled: disabled.map((module) => module.name),
	};
}

function inertPlugin() {
	return { name: "builtin-module-stubs", setup() {} };
}
