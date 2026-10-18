/**
 * Reads the built-in module list out of packages/coding-agent/src/modules/index.ts
 * so the build scripts do not keep a second copy of it.
 *
 * The file is parsed, not imported: importing it would pull the whole
 * coding-agent graph (and @nanopi/pi-extra, which a flavor may be excluding)
 * into the build process. Every entry in BUILTIN_MODULES is one object literal
 * on its own line with a quoted `name`, which is all this needs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { specifierFor } from "./build-modules.mjs";

const codingAgentDir = join("packages", "coding-agent");
const codingAgentSrcDir = join(codingAgentDir, "src");

const ENTRY = /^\t\{ name: "([^"]+)"[^\n]*\},?$/gm;

/** @returns {string[]} module names in registration order */
export function readBuiltinModuleNames(repoRoot) {
	const path = join(repoRoot, codingAgentSrcDir, "modules", "index.ts");
	const source = readFileSync(path, "utf8");
	const start = source.indexOf("export const BUILTIN_MODULES");
	if (start === -1) throw new Error(`${path} no longer exports BUILTIN_MODULES`);
	const end = source.indexOf("\n];", start);
	if (end === -1) throw new Error(`${path}: could not find the end of BUILTIN_MODULES`);
	return [...source.slice(start, end).matchAll(ENTRY)].map((match) => match[1]);
}

/**
 * Module descriptors for the stub plugin: name plus the import specifiers
 * the coding-agent may write for it, taken from buildconfig.json's
 * `moduleBundles`. Two spellings are listed because the bundle can see the
 * compiled output either way: `../extras/x/index.js` from the modules barrel,
 * `../../extras/x/index.js` from an importer two levels below src.
 *
 * @returns {Array<{ name: string, specifiers: string[], source: string }>}
 */
export function resolveModuleBundles(repoRoot, config) {
	return config.moduleBundleNames.map((name) => {
		const source = join(repoRoot, config.moduleBundles[name].source);
		return {
			name,
			source,
			specifiers: [
				// The modules barrel sits one directory below src, so it writes
				// `../extras/x/index.js`; an importer at the src root writes
				// `./extras/x/index.js`. Both spellings point at the same file.
				specifierFor(join(repoRoot, codingAgentSrcDir), source),
				specifierFor(join(repoRoot, codingAgentSrcDir), source, 2),
			].filter((specifier) => specifier !== undefined),
		};
	});
}
