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
 * Components that are not plain switches:
 * - `toolset` picks one value from the top-level `toolsetComponents` map
 *   ("standard" or "bash"). It decides which built-in tools the build
 *   registers, so a tool set only ships whole.
 * - `providers` picks one entry from the top-level `providerSets` map (a named
 *   list of `@nanopi/pi-ai` provider ids). It decides which provider catalogs
 *   the model generator writes and the runtime registers, so a provider set
 *   only ships whole.
 * - `module/<name>` names each built-in module (packages/coding-agent/src/modules).
 *   Every `module/*` entry must match a name in the module list the bundle
 *   script passes to validateFlavorModules, so a new module cannot silently
 *   stay out of a flavor.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const BUILD_FLAVOR_ENV = "NANOPI_BUILD_FLAVOR";
export const BUILD_CONFIG_FILENAME = "buildconfig.json";

const COMPONENT_NAME_PATTERN = /^[a-z][a-z0-9-.]*(\/[a-z][a-z0-9-.]*)*$/;
const WILDCARD_KEY = "*";
/** Component whose value names a tool set instead of switching inclusion on. */
export const TOOLSET_COMPONENT = "toolset";
/** Component whose value names a provider set instead of switching inclusion on. */
export const PROVIDERS_COMPONENT = "providers";
/** Prefix of the per-module components. */
export const MODULE_COMPONENT_PREFIX = "module/";
/** Provider set entry meaning "every built-in catalog", checked at build time. */
export const ALL_PROVIDERS = "__ALL__";

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
 * @returns {{ defaultFlavor: string, componentNames: string[], toolsetComponents: string[], providerSets: Record<string, { description?: string, providers: string[] }>, moduleBundles: Record<string, { source: string }>, moduleBundleNames: string[], flavors: Record<string, { description?: string, components: Record<string, boolean | string> }> }}
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
		(key) =>
			!["defaultFlavor", "components", "flavors", "toolsetComponents", "providerSets", "moduleBundles"].includes(key),
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

	const providerSets = raw.providerSets;
	if (providerSets !== undefined) {
		if (typeof providerSets !== "object" || providerSets === null || Array.isArray(providerSets)) {
			throw new Error(`${BUILD_CONFIG_FILENAME} "providerSets" must be an object of provider set names`);
		}
		if (Object.keys(providerSets).length === 0) throw new Error(`${BUILD_CONFIG_FILENAME} "providerSets" declares no provider sets`);
		for (const [name, spec] of Object.entries(providerSets)) {
			if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
				throw new Error(`Provider set "${name}" in ${BUILD_CONFIG_FILENAME} must be an object`);
			}
			const unknownProviderSetKeys = Object.keys(spec).filter((key) => key !== "description" && key !== "providers");
			if (unknownProviderSetKeys.length > 0) {
				throw new Error(`Provider set "${name}" in ${BUILD_CONFIG_FILENAME} has unknown keys: ${unknownProviderSetKeys.join(", ")}`);
			}
			if (spec.description !== undefined && typeof spec.description !== "string") {
				throw new Error(`Provider set "${name}" in ${BUILD_CONFIG_FILENAME} has a non-string description`);
			}
			if (!Array.isArray(spec.providers) || spec.providers.length === 0) {
				throw new Error(`Provider set "${name}" in ${BUILD_CONFIG_FILENAME} must list at least one provider id`);
			}
			for (const providerId of spec.providers) {
				if (typeof providerId !== "string" || providerId.length === 0) {
					throw new Error(`Provider set "${name}" in ${BUILD_CONFIG_FILENAME} has a non-string provider id`);
				}
			}
			if (new Set(spec.providers).size !== spec.providers.length) {
				throw new Error(`Provider set "${name}" in ${BUILD_CONFIG_FILENAME} lists a provider id twice`);
			}
		}
	} else if (componentNames.includes(PROVIDERS_COMPONENT)) {
		throw new Error(`${BUILD_CONFIG_FILENAME} declares "${PROVIDERS_COMPONENT}" without a "providerSets" map`);
	}

	const providerSetNames = providerSets === undefined ? [] : Object.keys(providerSets);
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
			if (key === PROVIDERS_COMPONENT) {
				if (typeof value !== "string" || !providerSetNames.includes(value)) {
					throw new Error(
						`Flavor "${flavorName}" sets "${PROVIDERS_COMPONENT}" to an unknown provider set ` +
							`(declared: ${providerSetNames.join(", ") || "none"})`,
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
		providerSets: providerSets ?? {},
		moduleBundles: moduleBundles ?? {},
		moduleBundleNames,
		flavors: raw.flavors,
	};
}

/** Whether `key` names a declared component group, like "module/*". */
function isDeclaredGroupKey(key, componentNames) {
	const slash = key.lastIndexOf("/");
	if (slash === -1 || !key.endsWith("/*")) return false;
	const prefix = key.slice(0, slash + 1);
	return componentNames.some((name) => name.startsWith(prefix));
}

/**
 * The tool set a flavor selects. A flavor that does not name one gets
 * "standard": a tool set is a choice, never a side effect of the wildcard.
 *
 * @returns {string}
 */
export function resolveFlavorToolset(config, flavorName) {
	const flavor = config.flavors[flavorName];
	if (!flavor) {
		throw new Error(`Unknown build flavor "${flavorName}" (declared: ${Object.keys(config.flavors).join(", ")})`);
	}
	const selected = flavor.components[TOOLSET_COMPONENT];
	return typeof selected === "string" ? selected : "standard";
}

/**
 * The provider ids a flavor ships. A flavor that does not name a provider set
 * gets every built-in provider, so the default stays the full catalog.
 *
 * @returns {string[]}
 */
export function resolveFlavorProviders(config, flavorName) {
	const flavor = config.flavors[flavorName];
	if (!flavor) {
		throw new Error(`Unknown build flavor "${flavorName}" (declared: ${Object.keys(config.flavors).join(", ")})`);
	}
	// A flavor that names no provider set ships every catalog, like the default
	// of a switch. Which set that is reads from the flavor itself, not from a
	// hardcoded set name: a flavor may call its full set anything.
	const selected = flavor.components[PROVIDERS_COMPONENT];
	if (typeof selected !== "string") return [ALL_PROVIDERS];
	const providerSet = config.providerSets[selected];
	if (!providerSet) throw new Error(`Unknown provider set "${selected}" in flavor "${flavorName}"`);
	return providerSet.providers.includes(ALL_PROVIDERS) ? [ALL_PROVIDERS] : providerSet.providers;
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
				: name === PROVIDERS_COMPONENT
					? resolveFlavorProviders(config, flavorName)
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
 * Provider ids with a generated catalog module in packages/ai. Read from the
 * shard file names (`<artifact>.models.ts`) rather than from the data directory,
 * because that directory is a gitignored build product that a clean checkout
 * hydrates later.
 */
export function readProviderCatalogIds(repoRoot) {
	const providersDir = join(repoRoot, "packages", "ai", "src", "providers");
	const ids = readdirSync(providersDir)
		.filter((entry) => entry.endsWith(".models.ts"))
		.map((entry) => entry.slice(0, -".models.ts".length));
	if (ids.length === 0) throw new Error(`No generated provider catalogs found in ${providersDir}`);
	return ids.sort();
}

/**
 * Cross-checks the providers a flavor ships against the built-in catalogs in
 * packages/ai. A provider set that names a provider the catalog does not have,
 * or a catalog the flavors never ship, fails the build instead of producing a
 * build whose model list silently disagrees with its provider set.
 */
export function validateFlavorProviders(repoRoot, providerIds, flavorName) {
	const config = loadBuildConfig(repoRoot);
	const known = new Set(providerIds);
	for (const [name, providerSet] of Object.entries(config.providerSets)) {
		const unknown = providerSet.providers.filter(
			(providerId) => providerId !== ALL_PROVIDERS && !known.has(providerId),
		);
		if (unknown.length > 0) {
			throw new Error(
				`${BUILD_CONFIG_FILENAME} provider set "${name}" names providers without a built-in catalog: ${unknown.join(", ")}`,
			);
		}
	}
	const shipped = resolveFlavorProviders(config, flavorName);
	if (shipped.includes(ALL_PROVIDERS)) return;
	const knownIds = new Set(providerIds);
	const unreachable = providerIds.filter((providerId) => !shipped.includes(providerId));
	if (unreachable.length > 0) {
		throw new Error(
			`Flavor "${flavorName}" ships no provider set entry for: ${unreachable.join(", ")} ` +
				`(list it in a provider set, or mark that set "${ALL_PROVIDERS}")`,
		);
	}
	for (const providerId of shipped) {
		if (!knownIds.has(providerId)) {
			throw new Error(`Flavor "${flavorName}" ships an unknown provider: ${providerId}`);
		}
	}
}

/**
 * Full selection: CLI flag over NANOPI_BUILD_FLAVOR over defaultFlavor, then
 * resolved against the config. `toolset` is the selected tool set name and
 * `providers` the selected provider ids.
 *
 * @returns {{ flavor: string, components: Record<string, boolean | string>, toolset: string, providers: string[] }}
 */
export function resolveBuildFlavor(repoRoot, { argv = process.argv, env = process.env } = {}) {
	const config = loadBuildConfig(repoRoot);
	const flavor = parseFlavorArg(argv) ?? env[BUILD_FLAVOR_ENV] ?? config.defaultFlavor;
	return {
		flavor,
		components: resolveFlavorComponents(config, flavor),
		toolset: resolveFlavorToolset(config, flavor),
		providers: resolveFlavorProviders(config, flavor),
	};
}
