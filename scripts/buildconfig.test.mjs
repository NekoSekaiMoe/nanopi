import assert, { deepStrictEqual, strictEqual, throws } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	ALL_APIS,
	ALL_PROVIDERS,
	BUILD_FLAVOR_ENV,
	NO_PROVIDERS,
	loadBuildConfig,
	parseFlavorArg,
	resolveBuildFlavor,
	resolveBuiltinApiIds,
	resolveBuiltinProviderIds,
	resolveFlavorApis,
	resolveFlavorComponents,
	resolveFlavorProviders,
	resolveFlavorToolNames,
	resolveFlavorToolset,
	validateFlavorModules,
	validateFlavorProviders,
} from "./buildconfig.mjs";

const validConfig = {
	defaultFlavor: "full",
	components: {
		webui: { description: "Browser UI" },
		"oauth/xai": { description: "xAI OAuth flow" },
		goal: { description: "Goal tracking module" },
	},
	flavors: {
		full: { components: { "*": true } },
		minimal: { components: { "*": false } },
		custom: { components: { webui: false, "oauth/xai": true } },
		partial: { components: { webui: false } },
	},
};

function writeConfig(config) {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-buildconfig-"));
	writeFileSync(join(dir, "buildconfig.json"), JSON.stringify(config));
	return dir;
}

let tempDirs = [];

describe("parseFlavorArg", () => {
	it("reads --flavor <name> and --flavor=<name>", () => {
		strictEqual(parseFlavorArg(["node", "script.mjs", "--flavor", "minimal"]), "minimal");
		strictEqual(parseFlavorArg(["--flavor=minimal"]), "minimal");
	});

	it("returns undefined without the flag", () => {
		strictEqual(parseFlavorArg(["node", "script.mjs", "--out", "x"]), undefined);
	});

	it("throws when the flag has no value", () => {
		throws(() => parseFlavorArg(["--flavor"]), /--flavor requires a flavor name/);
		throws(() => parseFlavorArg(["--flavor="]), /--flavor requires a flavor name/);
	});
});

describe("loadBuildConfig", () => {
	beforeEach(() => {
		tempDirs.push(writeConfig(validConfig));
	});
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("loads a valid config", () => {
		const config = loadBuildConfig(tempDirs.at(-1));
		strictEqual(config.defaultFlavor, "full");
		strictEqual(config.componentNames.length, 3);
	});

	it("rejects unknown top-level keys", () => {
		const dir = writeConfig({ ...validConfig, extra: 1 });
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /unknown top-level keys: extra/);
	});

	it("rejects invalid component names", () => {
		const components = { ...validConfig.components, "Bad Name": {} };
		const dir = writeConfig({ ...validConfig, components });
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /Invalid component name "Bad Name"/);
	});

	it("rejects flavors referencing undeclared components", () => {
		const flavors = { ...validConfig.flavors, broken: { components: { nope: true } } };
		const dir = writeConfig({ ...validConfig, flavors });
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /undeclared component "nope"/);
	});

	it("rejects non-boolean component values", () => {
		const flavors = { ...validConfig.flavors, broken: { components: { webui: "yes" } } };
		const dir = writeConfig({ ...validConfig, flavors });
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /non-boolean/);
	});

	it("rejects a defaultFlavor that is not declared", () => {
		const dir = writeConfig({ ...validConfig, defaultFlavor: "missing" });
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /defaultFlavor "missing" is not a declared flavor/);
	});

	it("rejects empty components and flavors", () => {
		let dir = writeConfig({ ...validConfig, components: {} });
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /declares no components/);
		dir = writeConfig({ ...validConfig, flavors: {} });
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /declares no flavors/);
	});

	it("throws a readable error for a missing file", () => {
		const dir = mkdtempSync(join(tmpdir(), "nanopi-buildconfig-empty-"));
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /Failed to read buildconfig\.json/);
	});
});

describe("resolveFlavorComponents", () => {
	const config = loadBuildConfig(writeConfig(validConfig));
	tempDirs.length = 0;

	it("expands wildcard flavors to every component", () => {
		strictEqual(resolveFlavorComponents(config, "full").webui, true);
		strictEqual(resolveFlavorComponents(config, "full")["oauth/xai"], true);
		strictEqual(resolveFlavorComponents(config, "minimal").webui, false);
		strictEqual(resolveFlavorComponents(config, "minimal")["oauth/xai"], false);
	});

	it("falls back to enabled for components a flavor does not list", () => {
		const components = resolveFlavorComponents(config, "partial");
		strictEqual(components.webui, false);
		strictEqual(components["oauth/xai"], true);
		strictEqual(components.goal, true);
	});

	it("mixes explicit entries over the wildcard-less default", () => {
		const components = resolveFlavorComponents(config, "custom");
		strictEqual(components.webui, false);
		strictEqual(components["oauth/xai"], true);
		strictEqual(components.goal, true);
	});

	it("throws on unknown flavors", () => {
		throws(() => resolveFlavorComponents(config, "nope"), /Unknown build flavor "nope"/);
	});
});

describe("resolveBuildFlavor selection order", () => {
	beforeEach(() => {
		tempDirs.push(writeConfig(validConfig));
	});
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("prefers the CLI flag over env and default", () => {
		const resolved = resolveBuildFlavor(tempDirs.at(-1), {
			argv: ["--flavor", "minimal"],
			env: { [BUILD_FLAVOR_ENV]: "custom" },
		});
		strictEqual(resolved.flavor, "minimal");
		strictEqual(resolved.components.webui, false);
	});

	it("falls back to the env variable, then defaultFlavor", () => {
		strictEqual(resolveBuildFlavor(tempDirs.at(-1), { argv: [], env: { [BUILD_FLAVOR_ENV]: "custom" } }).flavor, "custom");
		strictEqual(resolveBuildFlavor(tempDirs.at(-1), { argv: [], env: {} }).flavor, "full");
	});

	it("throws on unknown selected flavors", () => {
		throws(() => resolveBuildFlavor(tempDirs.at(-1), { argv: ["--flavor", "nope"], env: {} }), /Unknown build flavor "nope"/);
	});
});

describe("toolset components", () => {
	const config = {
		defaultFlavor: "full",
		components: { toolset: { description: "Tool set" }, webui: {} },
		toolsetComponents: { standard: {}, bash: {} },
		flavors: {
			full: { components: { "*": true } },
			bashOnly: { components: { "*": true, toolset: "bash" } },
		},
	};

	it("defaults to standard when a flavor names no tool set", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		strictEqual(resolveFlavorToolset(loadBuildConfig(dir), "full"), "standard");
		strictEqual(resolveBuildFlavor(dir, { argv: ["--flavor", "full"], env: {} }).toolset, "standard");
	});

	it("reads the named tool set", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		const resolved = resolveBuildFlavor(dir, { argv: ["--flavor", "bashOnly"], env: {} });
		strictEqual(resolved.toolset, "bash");
		strictEqual(resolved.components.toolset, "bash");
	});

	it("rejects an undeclared tool set", () => {
		const dir = writeConfig({
			...config,
			flavors: { ...config.flavors, broken: { components: { "*": true, toolset: "nope" } } },
		});
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /sets "toolset" to an unknown tool set/);
	});

	it("rejects a toolset component without a toolsetComponents map", () => {
		const dir = writeConfig({ ...config, toolsetComponents: undefined });
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /declares "toolset" without a "toolsetComponents" map/);
	});
});

describe("providers component", () => {
	const config = {
		defaultFlavor: "full",
		components: { providers: { description: "Provider set" }, webui: {} },
		// `core` is the curated set a trimmed flavor ships; it is not the whole
		// catalog, which is the shape `base` has in the real buildconfig.
		providerSets: {
			all: { description: "Every catalog", providers: ["__ALL__"] },
			none: { description: "No catalog", providers: ["__NONE__"] },
			presets: { description: "Presets", providers: ["openai", "anthropic"] },
			core: { description: "Curated", providers: ["openai"] },
		},
		flavors: {
			full: { components: { "*": true, providers: "all" } },
			small: { components: { "*": false, providers: "presets" } },
			trimmed: { components: { "*": false, providers: "core" } },
			empty: { components: { "*": false, providers: "none" } },
			unnamed: { components: { "*": true } },
		},
	};

	it("reads the named provider set", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		strictEqual(resolveFlavorProviders(loadBuildConfig(dir), "small").join(","), "openai,anthropic");
		strictEqual(
			resolveBuildFlavor(dir, { argv: ["--flavor", "small"], env: {} }).providers.join(","),
			"openai,anthropic",
		);
	});

	it("defaults to every provider when a flavor names no provider set", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		const resolved = resolveBuildFlavor(dir, { argv: ["--flavor", "unnamed"], env: {} });
		strictEqual(resolved.providers.join(","), ALL_PROVIDERS);
	});

	it("rejects an undeclared provider set", () => {
		const dir = writeConfig({
			...config,
			flavors: { ...config.flavors, broken: { components: { "*": true, providers: "nope" } } },
		});
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /sets "providers" to an unknown provider set/);
	});

	it("rejects a providers component without a providerSets map", () => {
		const dir = writeConfig({ ...config, providerSets: undefined });
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /declares "providers" without a "providerSets" map/);
	});

	it("rejects a provider set that names an unknown provider", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		throws(
			() => validateFlavorProviders(dir, [], "small"),
			/provider set "presets" names providers without a built-in catalog: openai, anthropic/,
		);
	});

	it("rejects a catalog that no provider set can select", () => {
		// Same sets with the marker dropped: `google` has a catalog, but no set
		// lists it, so no flavor could ever reach it.
		const dir = writeConfig({
			...config,
			providerSets: { ...config.providerSets, all: { description: "Every catalog", providers: ["openai", "anthropic"] } },
		});
		tempDirs.push(dir);
		throws(() => validateFlavorProviders(dir, ["openai", "anthropic", "google"], "full"), /No provider set lists: google/);
	});

	it("accepts a flavor that ships less than the whole catalog", () => {
		const withFullSet = {
			...config,
			providerSets: { ...config.providerSets, every: { providers: ["__ALL__"] } },
			flavors: { ...config.flavors, trimmed: { components: { "*": false, providers: "core" } } },
		};
		const dir = writeConfig(withFullSet);
		tempDirs.push(dir);
		// `trimmed` ships `core` (openai only): fewer than the three catalogs that
		// exist, which is exactly what `base` does with the other 40 vendors.
		validateFlavorProviders(dir, ["openai", "anthropic", "google"], "trimmed");
		strictEqual(resolveFlavorProviders(loadBuildConfig(dir), "trimmed").join(","), "openai");
	});

	it("accepts a flavor that ships every catalog through the full set marker", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		validateFlavorProviders(dir, ["openai", "anthropic", "google"], "full");
	});

	it("resolves a set with no provider to an empty registration list", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		const loaded = loadBuildConfig(dir);
		strictEqual(resolveFlavorProviders(loaded, "empty").join(","), NO_PROVIDERS);
		strictEqual(resolveBuiltinProviderIds(resolveFlavorProviders(loaded, "empty")).length, 0);
		strictEqual(resolveBuiltinProviderIds(resolveFlavorProviders(loaded, "full")), undefined);
		strictEqual(
			resolveBuiltinProviderIds(resolveFlavorProviders(loaded, "small")).join(","),
			"openai,anthropic",
		);
	});

	it("accepts a flavor with no provider without cross-checking the catalogs", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		validateFlavorProviders(dir, ["openai", "anthropic", "google"], "empty");
	});

	it("rejects a marker listed alongside concrete provider ids", () => {
		const withAll = writeConfig({
			...config,
			providerSets: { ...config.providerSets, mixed: { providers: [ALL_PROVIDERS, "openai"] } },
		});
		const withNone = writeConfig({
			...config,
			providerSets: { ...config.providerSets, mixed: { providers: ["openai", NO_PROVIDERS] } },
		});
		tempDirs.push(withAll, withNone);
		throws(() => loadBuildConfig(withAll), /uses "__ALL__" alongside concrete provider ids/);
		throws(() => loadBuildConfig(withNone), /uses "__NONE__" alongside concrete provider ids/);
	});

	it("reads the no-provider set from the real buildconfig", () => {
		const loaded = loadBuildConfig(join(import.meta.dirname, ".."));
		strictEqual(loaded.flavors.minimal.components.providers, "none");
		strictEqual(resolveBuiltinProviderIds(resolveFlavorProviders(loaded, "minimal")).length, 0);
	});
});

describe("module components", () => {
	const modules = ["alpha", "beta"];
	const config = {
		defaultFlavor: "full",
		components: { "module/alpha": {}, "module/beta": {} },
		moduleBundles: {
			alpha: { source: "packages/coding-agent/src/modules/alpha/index.ts" },
			beta: { source: "packages/coding-agent/src/extras/beta/index.ts" },
		},
		flavors: {
			full: { components: { "*": true } },
			few: { components: { "*": true, "module/beta": false } },
			group: { components: { "*": false, "module/*": true } },
		},
	};

	it("allows a group key to set every module at once", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		const components = resolveFlavorComponents(loadBuildConfig(dir), "group");
		strictEqual(components["module/alpha"], true);
		strictEqual(components["module/beta"], true);
	});

	it("lets a named module override the group key", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		const components = resolveFlavorComponents(loadBuildConfig(dir), "few");
		strictEqual(components["module/alpha"], true);
		strictEqual(components["module/beta"], false);
	});

	it("rejects a module bundle without its component", () => {
		const dir = writeConfig({
			...config,
			moduleBundles: { ...config.moduleBundles, gamma: { source: "packages/coding-agent/src/x.ts" } },
		});
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /entry "gamma" has no "module\/gamma" component/);
	});

	it("rejects an out-of-sync module list", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		throws(() => validateFlavorModules(dir, ["alpha"]), /"moduleBundles" does not list every builtin module/);
		throws(() => validateFlavorModules(dir, ["alpha", "beta", "gamma"]), /modules without a "module\/" component: gamma/);
		assert.doesNotThrow(() => validateFlavorModules(dir, modules));
	});
});

describe("tool set tools", () => {
	const config = {
		defaultFlavor: "full",
		components: { toolset: { description: "Tool set" }, "tools/read": {}, "tools/bash": {} },
		toolsetComponents: {
			standard: {},
			bash: { tools: ["bash", "powershell"] },
		},
		flavors: {
			full: { components: { "*": true } },
			shell: { components: { "*": true, toolset: "bash" } },
		},
	};

	it("reports no tool list for a set that does not name its tools", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		strictEqual(resolveFlavorToolNames(loadBuildConfig(dir), "full"), undefined);
		strictEqual(resolveBuildFlavor(dir, { argv: ["--flavor", "full"], env: {} }).toolNames, undefined);
	});

	it("reports the tools of a set that names them", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		deepStrictEqual(resolveFlavorToolNames(loadBuildConfig(dir), "shell"), ["bash", "powershell"]);
	});

	it("derives the per-tool components from the selected tool set", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		const components = resolveFlavorComponents(loadBuildConfig(dir), "shell");
		strictEqual(components["tools/bash"], true);
		strictEqual(components["tools/read"], false);
	});

	it("rejects a tool set with a malformed tools list", () => {
		const dir = writeConfig({
			...config,
			toolsetComponents: { ...config.toolsetComponents, bash: { tools: "bash" } },
		});
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /must list its "tools" as a non-empty array/);
	});

	it("rejects a tool set that lists a tool twice", () => {
		const dir = writeConfig({
			...config,
			toolsetComponents: { ...config.toolsetComponents, bash: { tools: ["bash", "bash"] } },
		});
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /lists a tool name twice/);
	});
});

describe("apis component", () => {
	const config = {
		defaultFlavor: "full",
		components: { apis: { description: "API set" }, webui: {} },
		apiSets: {
			all: { description: "Every implementation", apis: [ALL_APIS] },
			openai: { description: "Completions alone", apis: ["openai-completions"] },
		},
		flavors: {
			full: { components: { "*": true, apis: "all" } },
			small: { components: { "*": false, apis: "openai" } },
			unnamed: { components: { "*": true } },
		},
	};

	it("reads the named API set", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		deepStrictEqual(resolveFlavorApis(loadBuildConfig(dir), "small"), ["openai-completions"]);
		deepStrictEqual(resolveBuildFlavor(dir, { argv: ["--flavor", "small"], env: {} }).apis, ["openai-completions"]);
	});

	it("defaults to every implementation when a flavor names no API set", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		deepStrictEqual(resolveFlavorApis(loadBuildConfig(dir), "unnamed"), [ALL_APIS]);
	});

	it("keeps the full marker for the runtime to read as every implementation", () => {
		const dir = writeConfig(config);
		tempDirs.push(dir);
		deepStrictEqual(resolveBuiltinApiIds(resolveFlavorApis(loadBuildConfig(dir), "full")), [ALL_APIS]);
	});

	it("rejects an undeclared API set", () => {
		const dir = writeConfig({
			...config,
			flavors: { ...config.flavors, broken: { components: { "*": true, apis: "nope" } } },
		});
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /sets "apis" to an unknown API set/);
	});

	it("rejects an apis component without an apiSets map", () => {
		const dir = writeConfig({ ...config, apiSets: undefined });
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /declares "apis" without an "apiSets" map/);
	});

	it("rejects the full marker next to concrete ids", () => {
		const dir = writeConfig({
			...config,
			apiSets: { mixed: { apis: [ALL_APIS, "openai-completions"] } },
		});
		tempDirs.push(dir);
		throws(() => loadBuildConfig(dir), /uses "__ALL__" alongside concrete API ids/);
	});
});

describe("real flavors", () => {
	const config = loadBuildConfig(join(import.meta.dirname, ".."));

	// Every flavor but minimal ships the syntax-highlight grammars. The flavors
	// list them one by one over a `*: false` base, so the wildcard in `full` is
	// the only reason `full` has them; base lost them silently (its bundle was
	// 918 KiB smaller than main's while the diff touched nothing related).
	it("keeps syntax highlighting in every flavor but minimal", () => {
		strictEqual(resolveFlavorComponents(config, "full")["syntax-highlight"], true);
		strictEqual(resolveFlavorComponents(config, "base")["syntax-highlight"], true);
		strictEqual(resolveFlavorComponents(config, "minimal")["syntax-highlight"], false);
	});
});
