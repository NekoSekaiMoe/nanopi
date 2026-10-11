/**
 * Loader for buildconfig.json, the root-level registry of build flavors.
 *
 * A flavor resolves to a component map: for every component declared in
 * buildconfig.json, whether that flavor includes it. Consumers are the build
 * scripts (bundle, single-file, copy-assets), which drop disabled components
 * from their outputs and inject the resolved map as esbuild defines so the
 * runtime can report clean errors instead of module-not-found crashes.
 *
 * Flavor selection order: `--flavor <name>` CLI argument, then the
 * NANOPI_BUILD_FLAVOR environment variable (the propagation channel for
 * chained `pnpm run build` invocations), then the config's defaultFlavor.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BUILD_FLAVOR_ENV = "NANOPI_BUILD_FLAVOR";
export const BUILD_CONFIG_FILENAME = "buildconfig.json";

const COMPONENT_NAME_PATTERN = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/;
const WILDCARD_KEY = "*";

/** Extracts `--flavor <name>` / `--flavor=<name>` from an argv array. */
export function parseFlavorArg(argv) {
	const flagIndex = argv.indexOf("--flavor");
	if (flagIndex !== -1) {
		const value = argv[flagIndex + 1];
		if (!value) throw new Error("--flavor requires a flavor name");
		return value;
	}
	for (const arg of argv) {
		if (arg.startsWith("--flavor=")) {
			const value = arg.slice("--flavor=".length);
			if (!value) throw new Error("--flavor requires a flavor name");
			return value;
		}
	}
	return undefined;
}

/**
 * Loads and validates buildconfig.json. Throws on structural problems so a
 * typo fails the build instead of silently shipping the wrong components.
 *
 * @returns {{ defaultFlavor: string, componentNames: string[], flavors: Record<string, { description?: string, components: Record<string, boolean> }> }}
 */
export function loadBuildConfig(repoRoot) {
	const configPath = join(repoRoot, BUILD_CONFIG_FILENAME);
	let raw;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch (error) {
		throw new Error(`Failed to read ${BUILD_CONFIG_FILENAME}: ${error.message}`);
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error(`${BUILD_CONFIG_FILENAME} must be a JSON object`);
	}

	const unknownKeys = Object.keys(raw).filter((key) => !["defaultFlavor", "components", "flavors"].includes(key));
	if (unknownKeys.length > 0) {
		throw new Error(`${BUILD_CONFIG_FILENAME} has unknown top-level keys: ${unknownKeys.join(", ")}`);
	}
	if (typeof raw.defaultFlavor !== "string" || raw.defaultFlavor.length === 0) {
		throw new Error(`${BUILD_CONFIG_FILENAME} must set "defaultFlavor" to a flavor name`);
	}
	if (typeof raw.components !== "object" || raw.components === null || Array.isArray(raw.components)) {
		throw new Error(`${BUILD_CONFIG_FILENAME} must declare a "components" object`);
	}
	if (typeof raw.flavors !== "object" || raw.flavors === null || Array.isArray(raw.flavors)) {
		throw new Error(`${BUILD_CONFIG_FILENAME} must declare a "flavors" object`);
	}

	const componentNames = Object.keys(raw.components);
	if (componentNames.length === 0) {
		throw new Error(`${BUILD_CONFIG_FILENAME} declares no components`);
	}
	for (const [name, component] of Object.entries(raw.components)) {
		if (!COMPONENT_NAME_PATTERN.test(name)) {
			throw new Error(`Invalid component name "${name}" in ${BUILD_CONFIG_FILENAME} (expected lower-kebab, optionally one "/" group)`);
		}
		if (typeof component !== "object" || component === null || Array.isArray(component)) {
			throw new Error(`Component "${name}" in ${BUILD_CONFIG_FILENAME} must be an object`);
		}
		const unknownComponentKeys = Object.keys(component).filter((key) => key !== "description");
		if (unknownComponentKeys.length > 0) {
			throw new Error(`Component "${name}" in ${BUILD_CONFIG_FILENAME} has unknown keys: ${unknownComponentKeys.join(", ")}`);
		}
		if (component.description !== undefined && typeof component.description !== "string") {
			throw new Error(`Component "${name}" in ${BUILD_CONFIG_FILENAME} has a non-string description`);
		}
	}

	const flavorNames = Object.keys(raw.flavors);
	if (flavorNames.length === 0) {
		throw new Error(`${BUILD_CONFIG_FILENAME} declares no flavors`);
	}
	for (const [flavorName, flavor] of Object.entries(raw.flavors)) {
		if (typeof flavor !== "object" || flavor === null || Array.isArray(flavor)) {
			throw new Error(`Flavor "${flavorName}" in ${BUILD_CONFIG_FILENAME} must be an object`);
		}
		const unknownFlavorKeys = Object.keys(flavor).filter((key) => key !== "description" && key !== "components");
		if (unknownFlavorKeys.length > 0) {
			throw new Error(`Flavor "${flavorName}" in ${BUILD_CONFIG_FILENAME} has unknown keys: ${unknownFlavorKeys.join(", ")}`);
		}
		if (flavor.description !== undefined && typeof flavor.description !== "string") {
			throw new Error(`Flavor "${flavorName}" in ${BUILD_CONFIG_FILENAME} has a non-string description`);
		}
		if (flavor.components === undefined) {
			throw new Error(`Flavor "${flavorName}" in ${BUILD_CONFIG_FILENAME} must declare a "components" object`);
		}
		if (typeof flavor.components !== "object" || flavor.components === null || Array.isArray(flavor.components)) {
			throw new Error(`Flavor "${flavorName}" in ${BUILD_CONFIG_FILENAME} must declare a "components" object`);
		}
		for (const [key, value] of Object.entries(flavor.components)) {
			if (key !== WILDCARD_KEY && !componentNames.includes(key)) {
				throw new Error(`Flavor "${flavorName}" references undeclared component "${key}"`);
			}
			if (typeof value !== "boolean") {
				throw new Error(`Flavor "${flavorName}" sets component "${key}" to a non-boolean value`);
			}
		}
	}
	if (!(raw.defaultFlavor in raw.flavors)) {
		throw new Error(`${BUILD_CONFIG_FILENAME} defaultFlavor "${raw.defaultFlavor}" is not a declared flavor`);
	}

	return { defaultFlavor: raw.defaultFlavor, componentNames, flavors: raw.flavors };
}

/**
 * Resolves a flavor to its component map. Unlisted components fall back to
 * the flavor's "*" entry, then to enabled (safe default: a component added to
 * buildconfig.json but forgotten in a flavor stays bundled).
 *
 * @returns {Record<string, boolean>}
 */
export function resolveFlavorComponents(config, flavorName) {
	const flavor = config.flavors[flavorName];
	if (!flavor) {
		throw new Error(`Unknown build flavor "${flavorName}" (declared: ${Object.keys(config.flavors).join(", ")})`);
	}
	const components = {};
	for (const name of config.componentNames) {
		components[name] = flavor.components[name] ?? flavor.components[WILDCARD_KEY] ?? true;
	}
	return components;
}

/**
 * Full selection: CLI flag over NANOPI_BUILD_FLAVOR over defaultFlavor, then
 * resolved against the config.
 *
 * @returns {{ flavor: string, components: Record<string, boolean> }}
 */
export function resolveBuildFlavor(repoRoot, { argv = process.argv, env = process.env } = {}) {
	const config = loadBuildConfig(repoRoot);
	const flavor = parseFlavorArg(argv) ?? env[BUILD_FLAVOR_ENV] ?? config.defaultFlavor;
	return { flavor, components: resolveFlavorComponents(config, flavor) };
}
