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
 * NANOPI_BUILD_FLAVOR environment variable, then the config's defaultFlavor.
 * A caller for whom the environment is not the right channel passes its own
 * `env` (copy-assets does, so a build script's exported flavor cannot leak into
 * the shared dist/).
 *
 * Components that are not plain switches:
 * - `toolset` picks one value from the top-level `toolsetComponents` map
 *   ("standard" or "bash"). It decides which built-in tools the build
 *   registers, so a tool set only ships whole. A tool set that lists `tools`
 *   also names the tools themselves, and the bundle script drops the tool
 *   definitions it leaves out (see scripts/build-tools.mjs).
 * - `providers` picks one entry from the top-level `providerSets` map (a named
 *   list of `@nanopi/pi-ai` provider ids, or the `__NONE__` marker for a build
 *   that ships none). It decides which provider catalogs the model generator
 *   writes and the runtime registers, so a provider set only ships whole.
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
/** Component whose value names an API set instead of switching inclusion on. */
export const APIS_COMPONENT = "apis";
/** API set entry meaning "every API implementation in packages/ai". */
export const ALL_APIS = "__ALL__";
/**
 * Built-in tool names the session knows. A tool set that lists its tools is
 * cross-checked against this list (see scripts/build-tools.mjs), so a renamed
 * tool fails the build instead of leaving its implementation bundled.
 */
export const ALL_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
/** Prefix of the per-tool components. */
export const TOOLS_COMPONENT_PREFIX = "tools/";

/**
 * Key of a tool set entry that lists the built-in tool names it ships. A set
 * without it ships every tool definition; the build then filters at runtime
 * only, which keeps the code of the other tools in the bundle.
 */
export const TOOLSET_TOOLS_KEY = "tools";
/** Prefix of the per-module components. */
export const MODULE_COMPONENT_PREFIX = "module/";
/** Provider set entry meaning "every built-in catalog", checked at build time. */
export const ALL_PROVIDERS = "__ALL__";
/** Provider set entry meaning "no built-in catalog", checked at build time. */
export const NO_PROVIDERS = "__NONE__";

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
			!["defaultFlavor", "components", "flavors", "toolsetComponents", "providerSets", "apiSets", "moduleBundles"].includes(
				key,
			),
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
			const unknownToolsetKeys = Object.keys(spec).filter((key) => key !== "description" && key !== TOOLSET_TOOLS_KEY);
			if (unknownToolsetKeys.length > 0) {
				throw new Error(`Tool set "${name}" in ${BUILD_CONFIG_FILENAME} has unknown keys: ${unknownToolsetKeys.join(", ")}`);
			}
			const tools = spec[TOOLSET_TOOLS_KEY];
			if (tools === undefined) continue;
			if (!Array.isArray(tools) || tools.length === 0) {
				throw new Error(`Tool set "${name}" in ${BUILD_CONFIG_FILENAME} must list its "tools" as a non-empty array`);
			}
			for (const tool of tools) {
				if (typeof tool !== "string" || tool.length === 0) {
					throw new Error(`Tool set "${name}" in ${BUILD_CONFIG_FILENAME} has a non-string tool name`);
				}
			}
			if (new Set(tools).size !== tools.length) {
				throw new Error(`Tool set "${name}" in ${BUILD_CONFIG_FILENAME} lists a tool name twice`);
			}
		}
	} else if (componentNames.includes(TOOLSET_COMPONENT)) {
		throw new Error(`${BUILD_CONFIG_FILENAME} declares "${TOOLSET_COMPONENT}" without a "toolsetComponents" map`);
	}
	const toolsetNames = toolsetComponents === undefined ? [] : Object.keys(toolsetComponents);
	const toolsetTools = Object.fromEntries(
		Object.entries(toolsetComponents ?? {}).map(([name, spec]) => [name, spec[TOOLSET_TOOLS_KEY] ?? []]),
	);

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
				throw new Error(
					`Provider set "${name}" in ${BUILD_CONFIG_FILENAME} needs a provider id list, ` +
						`or ["${NO_PROVIDERS}"] for a build with no built-in provider`,
				);
			}
			for (const providerId of spec.providers) {
				if (typeof providerId !== "string" || providerId.length === 0) {
					throw new Error(`Provider set "${name}" in ${BUILD_CONFIG_FILENAME} has a non-string provider id`);
				}
			}
			if (new Set(spec.providers).size !== spec.providers.length) {
				throw new Error(`Provider set "${name}" in ${BUILD_CONFIG_FILENAME} lists a provider id twice`);
			}
			// The markers describe the whole set, so they cannot sit next to ids: a
			// set that lists a provider ids itself, and a set that lists none must not
			// be mistaken for a partial list the build then complains about.
			const marker = spec.providers.find((providerId) => providerId === ALL_PROVIDERS || providerId === NO_PROVIDERS);
			if (marker !== undefined && spec.providers.length > 1) {
				throw new Error(
					`Provider set "${name}" in ${BUILD_CONFIG_FILENAME} uses "${marker}" alongside concrete provider ids`,
				);
			}
		}
	} else if (componentNames.includes(PROVIDERS_COMPONENT)) {
		throw new Error(`${BUILD_CONFIG_FILENAME} declares "${PROVIDERS_COMPONENT}" without a "providerSets" map`);
	}

	const providerSetNames = providerSets === undefined ? [] : Object.keys(providerSets);

	const apiSets = raw.apiSets;
	if (apiSets !== undefined) {
		if (typeof apiSets !== "object" || apiSets === null || Array.isArray(apiSets)) {
			throw new Error(`${BUILD_CONFIG_FILENAME} "apiSets" must be an object of API set names`);
		}
		if (Object.keys(apiSets).length === 0) throw new Error(`${BUILD_CONFIG_FILENAME} "apiSets" declares no API sets`);
		for (const [name, spec] of Object.entries(apiSets)) {
			if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
				throw new Error(`API set "${name}" in ${BUILD_CONFIG_FILENAME} must be an object`);
			}
			const unknownApiSetKeys = Object.keys(spec).filter((key) => key !== "description" && key !== "apis");
			if (unknownApiSetKeys.length > 0) {
				throw new Error(`API set "${name}" in ${BUILD_CONFIG_FILENAME} has unknown keys: ${unknownApiSetKeys.join(", ")}`);
			}
			if (spec.description !== undefined && typeof spec.description !== "string") {
				throw new Error(`API set "${name}" in ${BUILD_CONFIG_FILENAME} has a non-string description`);
			}
			if (!Array.isArray(spec.apis) || spec.apis.length === 0) {
				throw new Error(`API set "${name}" in ${BUILD_CONFIG_FILENAME} needs an API id list, or ["${ALL_APIS}"]`);
			}
			for (const apiId of spec.apis) {
				if (typeof apiId !== "string" || apiId.length === 0) {
					throw new Error(`API set "${name}" in ${BUILD_CONFIG_FILENAME} has a non-string API id`);
				}
			}
			if (new Set(spec.apis).size !== spec.apis.length) {
				throw new Error(`API set "${name}" in ${BUILD_CONFIG_FILENAME} lists an API id twice`);
			}
			if (spec.apis.includes(ALL_APIS) && spec.apis.length > 1) {
				throw new Error(`API set "${name}" in ${BUILD_CONFIG_FILENAME} uses "${ALL_APIS}" alongside concrete API ids`);
			}
		}
	} else if (componentNames.includes(APIS_COMPONENT)) {
		throw new Error(`${BUILD_CONFIG_FILENAME} declares "${APIS_COMPONENT}" without an "apiSets" map`);
	}
	const apiSetNames = apiSets === undefined ? [] : Object.keys(apiSets);

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
			if (key === APIS_COMPONENT) {
				if (typeof value !== "string" || !apiSetNames.includes(value)) {
					throw new Error(
						`Flavor "${flavorName}" sets "${APIS_COMPONENT}" to an unknown API set ` +
							`(declared: ${apiSetNames.join(", ") || "none"})`,
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
		toolsetTools,
		providerSets: providerSets ?? {},
		apiSets: apiSets ?? {},
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
 * The flavor entry of the config, or a throw naming the flavors that exist.
 * Every resolver below starts here, so an unknown flavor fails once, in one
 * message, instead of five copies of the same check.
 */
function requireFlavor(config, flavorName) {
	const flavor = config.flavors[flavorName];
	if (!flavor) {
		throw new Error(`Unknown build flavor "${flavorName}" (declared: ${Object.keys(config.flavors).join(", ")})`);
	}
	return flavor;
}

/**
 * One resolution pass over a flavor. The five public resolvers are thin reads
 * of this object, so the parts share the work: a component map needs the tool
 * set name, the tool names, the provider set and the API set, and the old code
 * re-derived each of them (and re-checked the flavor) at every entry point.
 *
 * @returns {{ flavor: Record<string, unknown>, toolset: string, toolNames: string[] | undefined, providers: string[], apis: string[], components: Record<string, boolean | string> }}
 */
function resolveFlavor(config, flavorName) {
	const flavor = requireFlavor(config, flavorName);

	// A tool set is a choice, never a side effect of the wildcard: a flavor that
	// does not name one gets "standard".
	const toolsetValue = flavor.components[TOOLSET_COMPONENT];
	const toolset = typeof toolsetValue === "string" ? toolsetValue : "standard";
	// Undefined means the set lists no tools, i.e. it ships every definition and
	// filters at runtime.
	const listedTools = config.toolsetTools?.[toolset];
	const toolNames = listedTools === undefined || listedTools.length === 0 ? undefined : [...listedTools];

	// A flavor that names no provider set ships every catalog, like the default of
	// a switch. Which set that is reads from the flavor itself, not from a
	// hardcoded set name: a flavor may call its full set anything.
	const providersValue = flavor.components[PROVIDERS_COMPONENT];
	let providers = [ALL_PROVIDERS];
	if (typeof providersValue === "string") {
		const providerSet = config.providerSets[providersValue];
		if (!providerSet) throw new Error(`Unknown provider set "${providersValue}" in flavor "${flavorName}"`);
		const marker = providerSet.providers.find(
			(providerId) => providerId === ALL_PROVIDERS || providerId === NO_PROVIDERS,
		);
		providers = marker === undefined ? [...providerSet.providers] : [marker];
	}

	// Same shape for APIs: no named set means every implementation, and the
	// `__ALL__` marker stays a marker the build resolves against the registry.
	const apisValue = flavor.components[APIS_COMPONENT];
	let apis = [ALL_APIS];
	if (typeof apisValue === "string") {
		const apiSet = config.apiSets[apisValue];
		if (!apiSet) throw new Error(`Unknown API set "${apisValue}" in flavor "${flavorName}"`);
		apis = apiSet.apis.includes(ALL_APIS) ? [ALL_APIS] : [...apiSet.apis];
	}

	const groupKeys = Object.keys(flavor.components).filter((key) => isDeclaredGroupKey(key, config.componentNames));
	const components = {};
	for (const name of config.componentNames) {
		const groupValue = groupKeys.find((key) => name.startsWith(key.slice(0, -1)));
		components[name] =
			name === TOOLSET_COMPONENT
				? toolset
				: name === PROVIDERS_COMPONENT
					? providers
					: name === APIS_COMPONENT
						? apis
						: name.startsWith(TOOLS_COMPONENT_PREFIX) && toolNames !== undefined
							? toolNames.includes(name.slice(TOOLS_COMPONENT_PREFIX.length))
							: (flavor.components[name] ??
								(groupValue === undefined ? undefined : flavor.components[groupValue]) ??
								flavor.components[WILDCARD_KEY] ??
								true);
	}

	return { toolset, toolNames, providers, apis, components };
}

/**
 * The tool set a flavor selects (`standard` when it names none).
 *
 * @returns {string}
 */
export function resolveFlavorToolset(config, flavorName) {
	return resolveFlavor(config, flavorName).toolset;
}

/**
 * The built-in tool names a flavor's tool set lists, or undefined when it
 * lists none (the set ships every tool definition and filters at runtime).
 *
 * @returns {string[] | undefined}
 */
export function resolveFlavorToolNames(config, flavorName) {
	return resolveFlavor(config, flavorName).toolNames;
}

/**
 * The provider ids a flavor ships: a concrete list, or the `__ALL__` /
 * `__NONE__` marker for a build that ships every catalog or none. Markers
 * expand to themselves so the callers keep one place that turns a set into
 * concrete ids (the model generator) and one that turns it into a runtime
 * filter (`[]` for none).
 *
 * @returns {string[]}
 */
export function resolveFlavorProviders(config, flavorName) {
	return resolveFlavor(config, flavorName).providers;
}

/**
 * The API ids a flavor ships: a concrete list or the `__ALL__` marker.
 *
 * @returns {string[]}
 */
export function resolveFlavorApis(config, flavorName) {
	return resolveFlavor(config, flavorName).apis;
}

/**
 * Resolves a flavor to its component map. Unlisted components fall back to
 * the flavor's "*" entry, then to enabled (safe default: a component added to
 * buildconfig.json but forgotten in a flavor stays bundled). The `toolset`,
 * `providers` and `apis` values are the selected names rather than switches,
 * and the `tools/<name>` components are a view of the tool set the flavor
 * picked: a set that lists its tools ships exactly those, and a set that lists
 * none leaves the group key to the flavor.
 *
 * @returns {Record<string, boolean | string>}
 */
export function resolveFlavorComponents(config, flavorName) {
	return resolveFlavor(config, flavorName).components;
}

/**
 * The API ids a build registers. The `__ALL__` marker stays as it is: the
 * runtime reads it as "every implementation", which keeps the registry whole
 * and filters nothing.
 *
 * @returns {string[]}
 */
export function resolveBuiltinApiIds(apis) {
	// Always a list: esbuild rejects an undefined define value, and an empty
	// list is not a state this config produces.
	return apis.includes(ALL_APIS) ? [ALL_APIS] : [...apis];
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
 * The concrete provider ids a build registers, or undefined when it ships every
 * catalog. The `__NONE__` marker resolves to an empty list: the build keeps no
 * built-in provider, and the model generator writes an empty catalog for it.
 *
 * @returns {string[] | undefined}
 */
export function resolveBuiltinProviderIds(providers) {
	if (providers.includes(ALL_PROVIDERS)) return undefined;
	return providers.includes(NO_PROVIDERS) ? [] : [...providers];
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
	const isMarker = (providerId) => providerId === ALL_PROVIDERS || providerId === NO_PROVIDERS;
	for (const [name, providerSet] of Object.entries(config.providerSets)) {
		const unknown = providerSet.providers.filter((providerId) => !isMarker(providerId) && !known.has(providerId));
		if (unknown.length > 0) {
			throw new Error(
				`${BUILD_CONFIG_FILENAME} provider set "${name}" names providers without a built-in catalog: ${unknown.join(", ")}`,
			);
		}
	}
	const shipped = resolveFlavorProviders(config, flavorName);
	// A flavor that ships every catalog, or no catalog at all, has nothing to
	// cross-check: one names no provider, the other names nothing but a marker.
	if (shipped.includes(ALL_PROVIDERS) || shipped.includes(NO_PROVIDERS)) return;
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
 * @returns {{ flavor: string, components: Record<string, boolean | string>, toolset: string, toolNames: string[] | undefined, providers: string[], apis: string[] }}
 */
export function resolveBuildFlavor(repoRoot, { argv = process.argv, env = process.env } = {}) {
	const config = loadBuildConfig(repoRoot);
	const flavorName = parseFlavorArg(argv) ?? env[BUILD_FLAVOR_ENV] ?? config.defaultFlavor;
	const { toolset, toolNames, providers, apis, components } = resolveFlavor(config, flavorName);
	return { flavor: flavorName, toolset, toolNames, providers, apis, components };
}
