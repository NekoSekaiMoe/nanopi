import assert, { strictEqual, throws } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	BUILD_FLAVOR_ENV,
	loadBuildConfig,
	parseFlavorArg,
	resolveBuildFlavor,
	resolveFlavorComponents,
	resolveFlavorToolset,
	validateFlavorModules,
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
