/**
 * Reads the built-in module list out of packages/coding-agent/src/modules/index.ts
 * so the build scripts do not keep a second copy of it.
 *
 * The file is parsed, not imported: importing it would pull the whole
 * coding-agent graph (and @nanopi/pi-extra, which a flavor may be excluding)
 * into the build process. Every entry in BUILTIN_MODULES is one object literal
 * on its own line with a quoted `name`, plus the spread entries that register a
 * module conditionally (`...extraModule()`, which drops `extra` from a
 * shell-only build). The spread's helper is then read for its literal `name:
 * "<x>"`, so `extra` is a module the config has to know about like any other.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { specifierFor } from "./build-modules.mjs";

const codingAgentDir = join("packages", "coding-agent");
const codingAgentSrcDir = join(codingAgentDir, "src");

const LITERAL_NAME = /\{\s*name: "([^"]+)"/g;

/**
 * Module names in `BUILTIN_MODULES` registration order. Entries are read in
 * source order and a spread entry contributes the literal `name` from the
 * helper it calls, so `...extraModule()` still counts `extra` (see the
 * file-level comment for why the file is parsed instead of imported).
 *
 * @returns {string[]}
 */
export function readBuiltinModuleNames(repoRoot) {
	const path = join(repoRoot, codingAgentSrcDir, "modules", "index.ts");
	const source = readFileSync(path, "utf8");
	const start = source.indexOf("export const BUILTIN_MODULES");
	if (start === -1) throw new Error(`${path} no longer exports BUILTIN_MODULES`);
	const end = source.indexOf("\n];", start);
	if (end === -1) throw new Error(`${path}: could not find the end of BUILTIN_MODULES`);
	const body = source.slice(start, end);
	const names = [];
	for (const line of body.split("\n")) {
		const entry = /^\t\{ name: "([^"]+)"/.exec(line);
		if (entry) {
			names.push(entry[1]);
			continue;
		}
		const spread = /^\t\.\.\.([A-Za-z0-9_$]+)\(\)/.exec(line);
		if (!spread) continue;
		const helper = readHelperModuleName(source, path, spread[1]);
		if (helper === undefined) {
			throw new Error(`${path}: cannot read the module name out of ${spread[1]}()`);
		}
		names.push(helper);
	}
	return names;
}

/** The literal `name: "<x>"` a `...helper()` spread registers, if it has one. */
function readHelperModuleName(source, path, helper) {
	const declaration = source.indexOf(`function ${helper}(`);
	if (declaration === -1) throw new Error(`${path}: ${helper}() is spread into BUILTIN_MODULES but not declared`);
	const body = /^function [A-Za-z0-9_$]+\([^)]*\)[^{]*\{([\s\S]*?)^\}/m.exec(source.slice(declaration));
	if (body === null) throw new Error(`${path}: could not read the body of ${helper}()`);
	LITERAL_NAME.lastIndex = 0;
	const literal = LITERAL_NAME.exec(body[1]);
	return literal?.[1];
}

/**
 * Module descriptors for the stub plugin: name plus the import specifiers
 * the coding-agent may write for it, taken from buildconfig.json's
 * `moduleBundles`. Two spellings are listed because the bundle can see the
 * compiled output either way: `../extras/x/index.js` from the modules barrel,
 * `../../extras/x/index.js` from an importer two levels below src.
 *
 * A module that lives outside the coding-agent package (`@nanopi/pi-extra`) is
 * imported by package name, so its specifier is the name itself and its stub
 * has to keep the named exports the coding-agent reads from it.
 *
 * @returns {Array<{ name: string, specifiers: string[], exportNames?: string[], source: string }>}
 */
export function resolveModuleBundles(repoRoot, config) {
	return config.moduleBundleNames.map((name) => {
		const bundle = config.moduleBundles[name];
		const source = join(repoRoot, bundle.source);
		if (bundle.package !== undefined) {
			return { name, source, specifiers: [bundle.package], exportNames: bundle.exportNames ?? [] };
		}
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
