/**
 * Bundled extras resolver, shared by the copy-assets and single-file build
 * scripts.
 *
 * Extras are vendored package directories under
 * packages/coding-agent/extras/<name>, one buildconfig.json component
 * `extra/<name>` each. Enabled extras are copied into dist/extras/<name> (npm
 * dist) and embedded in the single-file asset payload; the runtime registers
 * them as default packages (see src/core/bundled-extras.ts).
 *
 * validateBundledExtras keeps the directory and the component list in
 * lockstep: a vendored package without a component always ships (defeats the
 * flavor), a component without a directory silently ships nothing.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const EXTRAS_DIR_SEGMENTS = ["packages", "coding-agent", "extras"];

export function getExtrasDir(repoRoot) {
	return join(repoRoot, ...EXTRAS_DIR_SEGMENTS);
}

function listExtraNames(repoRoot) {
	const extrasDir = getExtrasDir(repoRoot);
	if (!existsSync(extrasDir)) return [];
	return readdirSync(extrasDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

function sortedDifference(left, right) {
	const rightSet = new Set(right);
	return left.filter((value) => !rightSet.has(value));
}

/**
 * Cross-checks extras directories against the resolved component map and
 * returns the enabled extras. A missing extras directory yields an empty
 * list (the published tarball carries only dist/extras); when present, every
 * directory and component must match.
 *
 * @returns {Array<{ name: string, sourceDir: string }>}
 */
export function resolveBundledExtras({ repoRoot, components }) {
	if (!existsSync(getExtrasDir(repoRoot))) return [];
	const dirNames = listExtraNames(repoRoot);
	const componentNames = Object.keys(components)
		.filter((name) => name.startsWith("extra/"))
		.map((name) => name.slice("extra/".length));

	const missingComponents = sortedDifference(dirNames, componentNames);
	if (missingComponents.length > 0) {
		throw new Error(`Vendored extras without an "extra/<name>" component in buildconfig.json: ${missingComponents.join(", ")}`);
	}
	const missingDirs = sortedDifference(componentNames, dirNames);
	if (missingDirs.length > 0) {
		throw new Error(`buildconfig.json declares extra components with no vendored directory: ${missingDirs.join(", ")}`);
	}

	return dirNames
		.filter((name) => components[`extra/${name}`] !== false)
		.map((name) => ({ name, sourceDir: join(getExtrasDir(repoRoot), name) }));
}
