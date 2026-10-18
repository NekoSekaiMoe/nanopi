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
 *
 * Two components are not switches:
 * - `toolset` picks one value from the top-level `toolsetComponents` map
 *   ("standard" or "bash"). It decides which built-in tools the build
 *   registers, so a tool set only ships whole.
 * - `module/<name>` names each built-in module (packages/coding-agent/src/modules).
 *   Every `module/*` entry must match a name in the module list the bundle
 *   script passes to validateFlavorModules, so a new module cannot silently
 *   stay out of a flavor.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BUILD_FLAVOR_ENV = "NANOPI_BUILD_FLAVOR";
export const BUILD_CONFIG_FILENAME = "buildconfig.json";

const COMPONENT_NAME_PATTERN = /^[a-z][a-z0-9-.]*(\/[a-z][a-z0-9-.]*)*$/;
const WILDCARD_KEY = "*";
/** Component whose value names a tool set instead of switching inclusion on. */
export const TOOLSET_COMPONENT = "toolset";
/** Prefix of the per-module components. */
export const MODULE_COMPONENT_PREFIX = "module/";

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
 * @returns {{ defaultFlavor: string, componentNames: string[], toolsetComponents: string[], flavors: Record<string, { description?: string, components: Record<string, boolean | string> }> }}
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

	const unknownKeys = Object.keys(raw).filter(
		(key) => !["defaultFlavor", "components", "flavors", "toolsetComponents", "moduleBundles"].includes(key),
	);
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

	const moduleBundles = raw.moduleBundles;
	if (moduleBundles !== undefined) {
		if (typeof moduleBundles !== "object" || moduleBundles === null || Array.isArray(moduleBundles)) {
			throw new Error(`${BUILD_CONFIG_FILENAME} "moduleBundles" must be an object keyed by module name`);
		}
		for (const [name, spec] of Object.entries(moduleBundles)) {
			if (!componentNames.includes(`${MODULE_COMPONENT_PREFIX}${name}`)) {
				throw new Error(`${BUILD_CONFIG_FILENAME} "moduleBundles" entry "${name}" has no "${MODULE_COMPONENT_PREFIX}${name}" component`);
			}
			const keys = typeof spec === "object" && spec !== null && !Array.isArray(spec) ? Object.keys(spec) : [];
			const unknownKeysForModule = keys.filter((key) => key !== "source");
			if (unknownKeysForModule.length > 0) {
				throw new Error(`"moduleBundles" entry "${name}" has unknown keys: ${unknownKeysForModule.join(", ")}`);
			}
			if (typeof spec.source !== "string") {
				throw new Error(`"moduleBundles" entry "${name}" must define a "source" path`);
			}
		}
	}
	const moduleBundleNames = moduleBundles === undefined ? [] : Object.keys(moduleBundles);

	const toolsetComponents = raw.toolsetComponents;
	if (toolsetComponents !== undefined) {
		if (typeof toolsetComponents !== "object" || toolsetComponents === null || Array.isArray(toolsetComponents)) {
			throw new Error(`${BUILD_CONFIG_FILENAME} "toolsetComponents" must be an object of tool set names`);
		}
		const toolsetNames = Object.keys(toolsetComponents);
		if (toolsetNames.length === 0) throw new Error(`${BUILD_CONFIG_FILENAME} "toolsetComponents" declares no tool sets`);
		for (const [name, spec] of Object.entries(toolsetComponents)) {
			if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
				throw new Error(`Tool set "${name}" in ${BUILD_CONFIG_FILENAME} must be an object`);
			}
			const unknownToolsetKeys = Object.keys(spec).filter((key) => key !== "description");
			if (unknownToolsetKeys.length > 0) {
				throw new Error(`Tool set "${name}" in ${BUILD_CONFIG_FILENAME} has unknown keys: ${unknownToolsetKeys.join(", ")}`);
			}
		}
	} else if (componentNames.includes(TOOLSET_COMPONENT)) {
		throw new Error(`${BUILD_CONFIG_FILENAME} declares "${TOOLSET_COMPONENT}" without a "toolsetComponents" map`);
	}
	const toolsetNames = toolsetComponents === undefined ? [] : Object.keys(toolsetComponents);

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
			// A flavor may set a group key ("module/*") that is not a component
			// itself; it only has to be a declared group prefix.
			if (key !== WILDCARD_KEY && !componentNames.includes(key) && !isDeclaredGroupKey(key, componentNames)) {
				throw new Error(`Flavor "${flavorName}" references undeclared component "${key}"`);
			}
			if (key === TOOLSET_COMPONENT) {
				if (typeof value !== "string" || !toolsetNames.includes(value)) {
					throw new Error(
						`Flavor "${flavorName}" sets "${TOOLSET_COMPONENT}" to an unknown tool set ` +
							`(declared: ${toolsetNames.join(", ") || "none"})`,
					);
				}
				continue;
			}
			if (typeof value !== "boolean") {
				throw new Error(`Flavor "${flavorName}" sets component "${key}" to a non-boolean value`);
			}
		}
	}
	if (!(raw.defaultFlavor in raw.flavors)) {
		throw new Error(`${BUILD_CONFIG_FILENAME} defaultFlavor "${raw.defaultFlavor}" is not a declared flavor`);
	}

	return {
		defaultFlavor: raw.defaultFlavor,
		componentNames,
		toolsetComponents: toolsetNames,
		moduleBundles: moduleBundles ?? {},
		moduleBundleNames,
		flavors: raw.flavors,
	};
}

/**
 * The tool set a flavor selects. A flavor that does not name one gets
 * "standard": a tool set is a choice, never a side effect of the wildcard.
 *
 * @returns {string}
 */
/** Whether `key` names a declared component group, like "module/*". */
function isDeclaredGroupKey(key, componentNames) {
	const slash = key.lastIndexOf("/");
	if (slash === -1 || !key.endsWith("/*")) return false;
	const prefix = key.slice(0, slash + 1);
	return componentNames.some((name) => name.startsWith(prefix));
}

export function resolveFlavorToolset(config, flavorName) {
	const flavor = config.flavors[flavorName];
	if (!flavor) {
		throw new Error(`Unknown build flavor "${flavorName}" (declared: ${Object.keys(config.flavors).join(", ")})`);
	}
	const selected = flavor.components[TOOLSET_COMPONENT];
	return typeof selected === "string" ? selected : "standard";
}

/**
 * Resolves a flavor to its component map. Unlisted components fall back to
 * the flavor's "*" entry, then to enabled (safe default: a component added to
 * buildconfig.json but forgotten in a flavor stays bundled). The `toolset`
 * value is the selected tool set name rather than a switch.
 *
 * @returns {Record<string, boolean | string>}
 */
export function resolveFlavorComponents(config, flavorName) {
	const flavor = config.flavors[flavorName];
	if (!flavor) {
		throw new Error(`Unknown build flavor "${flavorName}" (declared: ${Object.keys(config.flavors).join(", ")})`);
	}
	const groupKeys = Object.keys(flavor.components).filter((key) => isDeclaredGroupKey(key, config.componentNames));
	const components = {};
	for (const name of config.componentNames) {
		const groupValue = groupKeys.find((key) => name.startsWith(key.slice(0, -1)));
		components[name] =
			name === TOOLSET_COMPONENT
				? resolveFlavorToolset(config, flavorName)
				: (flavor.components[name] ?? (groupValue === undefined ? undefined : flavor.components[groupValue]) ?? flavor.components[WILDCARD_KEY] ?? true);
	}
	return components;
}

/**
 * Cross-checks the `module/<name>` components against the modules the build
 * actually registers. A module added without a component, or a component left
 * behind by a removed module, fails the build instead of shipping silently.
 */
export function validateFlavorModules(repoRoot, moduleNames) {
	const config = loadBuildConfig(repoRoot);
	const declared = new Set(
		config.componentNames
			.filter((name) => name.startsWith(MODULE_COMPONENT_PREFIX))
			.map((name) => name.slice(MODULE_COMPONENT_PREFIX.length)),
	);
	const registered = new Set(moduleNames);
	const details = [
		moduleNames.length > 0 && moduleNames.some((name) => !declared.has(name))
			? `modules without a "${MODULE_COMPONENT_PREFIX}" component: ${moduleNames.filter((name) => !declared.has(name)).join(", ")}`
			: undefined,
		[...declared].some((name) => !registered.has(name))
			? `"${MODULE_COMPONENT_PREFIX}" components for unknown modules: ${[...declared].filter((name) => !registered.has(name)).join(", ")}`
			: undefined,
		config.moduleBundleNames.length !== moduleNames.length ||
		config.moduleBundleNames.some((name) => !registered.has(name))
			? `"moduleBundles" does not list every builtin module (listed: ${config.moduleBundleNames.join(", ")})`
			: undefined,
	].filter(Boolean);
	if (details.length > 0) {
		throw new Error(`${BUILD_CONFIG_FILENAME} out of sync with builtin modules: ${details.join("; ")}`);
	}
}

/**
 * Full selection: CLI flag over NANOPI_BUILD_FLAVOR over defaultFlavor, then
 * resolved against the config. `toolset` is the selected tool set name.
 *
 * @returns {{ flavor: string, components: Record<string, boolean | string>, toolset: string }}
 */
export function resolveBuildFlavor(repoRoot, { argv = process.argv, env = process.env } = {}) {
	const config = loadBuildConfig(repoRoot);
	const flavor = parseFlavorArg(argv) ?? env[BUILD_FLAVOR_ENV] ?? config.defaultFlavor;
	return {
		flavor,
		components: resolveFlavorComponents(config, flavor),
		toolset: resolveFlavorToolset(config, flavor),
	};
}
