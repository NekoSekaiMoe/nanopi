import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repoBuildModule = fileURLToPath(new URL("../../../scripts/buildconfig.mjs", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/**
 * Copies the generator into a repo-shaped fixture so it resolves its own
 * buildconfig.json and writes it, instead of the checkout's.
 */
function createFixture(buildConfig: unknown) {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "nanopi-record-provider-set-"));
	temporaryRoots.push(fixtureRoot);
	const isolatedPackageRoot = join(fixtureRoot, "repo", "packages", "ai");
	mkdirSync(join(fixtureRoot, "repo", "scripts"), { recursive: true });
	mkdirSync(isolatedPackageRoot, { recursive: true });
	for (const entry of ["package.json", "scripts", "src"]) {
		cpSync(join(packageRoot, entry), join(isolatedPackageRoot, entry), { recursive: true });
	}
	cpSync(repoBuildModule, join(fixtureRoot, "repo", "scripts", "buildconfig.mjs"));
	const configPath = join(fixtureRoot, "repo", "buildconfig.json");
	writeFileSync(configPath, `${JSON.stringify(buildConfig, null, "\t")}\n`);
	return { fixtureRoot, isolatedPackageRoot, configPath };
}

/** Serves a models.dev payload whose only catalog is `morph`. */
function writeModelsDevPreload(fixtureRoot: string) {
	const preloadPath = join(fixtureRoot, "mock-models-dev.mjs");
	const catalog = {
		morph: {
			name: "Morph",
			api: "https://api.morph.example/v1",
			npm: "@ai-sdk/openai-compatible",
			models: { "morph-v3": { id: "morph-v3", name: "Morph v3", tool_call: true } },
		},
	};
	writeFileSync(
		preloadPath,
		`const catalog = ${JSON.stringify(catalog)};\n` +
			`globalThis.fetch = async (input) => {\n` +
			`  if (String(input) === "https://models.dev/api.json") {\n` +
			`    return new Response(JSON.stringify(catalog), { status: 200 });\n` +
			`  }\n` +
			`  throw new Error(\`Unexpected fetch: \${String(input)}\`);\n` +
			`};\n`,
	);
	return preloadPath;
}

function runGenerator(packageRoot: string, preloadPath: string, args: string[] = []) {
	return spawnSync(
		process.execPath,
		[
			"--import",
			fileURLToPath(new URL("../../../ts-import.mjs", import.meta.url)),
			"--import",
			pathToFileURL(preloadPath).href,
			"scripts/generate-models.ts",
			...args,
		],
		{ cwd: packageRoot, encoding: "utf8", timeout: 60_000 },
	);
}

function providerIdsOf(configPath: string, setName: string): string[] {
	const config = JSON.parse(readFileSync(configPath, "utf8")) as {
		providerSets: Record<string, { providers: string[] }>;
	};
	return config.providerSets[setName].providers;
}

describe("recordFullProviderSet", () => {
	// Issue #219: the full set holds concrete ids after the first recording run,
	// so the old marker lookup found nothing and the generator stopped writing
	// buildconfig.json at all. A provider models.dev added then left the config
	// naming a catalog set that no longer matched, and every following build
	// failed in validateFlavorProviders with "No provider set lists: <new id>".
	it("records a new catalog in the full set once the marker is gone", () => {
		const buildConfig = {
			defaultFlavor: "full",
			components: { providers: { description: "Provider set" } },
			providerSets: {
				all: { description: "Every catalog", providers: ["anthropic"] },
				none: { description: "No catalog", providers: ["__NONE__"] },
			},
			flavors: {
				full: { components: { "*": true, providers: "all" } },
				minimal: { components: { "*": false, providers: "none" } },
			},
		};
		const { fixtureRoot, isolatedPackageRoot, configPath } = createFixture(buildConfig);
		const preloadPath = writeModelsDevPreload(fixtureRoot);

		const result = runGenerator(isolatedPackageRoot, preloadPath);
		expect(`${result.stdout}\n${result.stderr}`).toContain('in buildconfig.json provider set "all"');
		// The new catalog is in the config, so the next build's
		// validateFlavorProviders finds it instead of failing.
		expect(providerIdsOf(configPath, "all")).toContain("morph");
	});

	it("leaves the config alone for a call that ships one explicit set", () => {
		const buildConfig = {
			defaultFlavor: "full",
			components: { providers: { description: "Provider set" } },
			providerSets: {
				all: { description: "Every catalog", providers: ["anthropic"] },
				none: { description: "No catalog", providers: ["__NONE__"] },
			},
			flavors: {
				full: { components: { "*": true, providers: "all" } },
				minimal: { components: { "*": false, providers: "none" } },
			},
		};
		const { fixtureRoot, isolatedPackageRoot, configPath } = createFixture(buildConfig);
		const preloadPath = writeModelsDevPreload(fixtureRoot);
		const before = readFileSync(configPath, "utf8");

		// `--providers` pins the run to the catalogs the fixture already has, so
		// the new models.dev catalog is not part of the recorded set.
		runGenerator(isolatedPackageRoot, preloadPath, ["--providers", "anthropic"]);
		expect(readFileSync(configPath, "utf8")).toBe(before);
	});

	// Issue #224: the disabled-shard stand-ins used to be written by hand, one per
	// provider in the trimmed set. A provider models.dev added came with a shard
	// but no stand-in, and every release build failed in validateStubs with a file
	// nobody wrote. The generator writes both halves now.
	it("writes the catalog shard and its disabled stand-in, and deletes orphaned stand-ins", () => {
		const buildConfig = {
			defaultFlavor: "full",
			components: { providers: { description: "Provider set" } },
			providerSets: {
				all: { description: "Every catalog", providers: ["__ALL__"] },
				none: { description: "No catalog", providers: ["__NONE__"] },
			},
			flavors: {
				full: { components: { "*": true, providers: "all" } },
				minimal: { components: { "*": false, providers: "none" } },
			},
		};
		const { fixtureRoot, isolatedPackageRoot } = createFixture(buildConfig);
		const preloadPath = writeModelsDevPreload(fixtureRoot);
		const disabledDir = join(isolatedPackageRoot, "src", "providers", "disabled");
		mkdirSync(disabledDir, { recursive: true });
		// A stand-in for a catalog that no longer exists: the old hand-written set,
		// left behind when its provider leaves models.dev.
		const orphanPath = join(disabledDir, "gone-models.ts");
		writeFileSync(orphanPath, "export const GONE_MODELS = {};\n");

		const result = runGenerator(isolatedPackageRoot, preloadPath);
		expect(result.status).toBe(0);

		expect(existsSync(join(isolatedPackageRoot, "src", "providers", "morph.models.ts"))).toBe(true);
		const stub = readFileSync(join(disabledDir, "morph-models.ts"), "utf8");
		// validateStubs compares value export names, so the stand-in has to carry
		// all three catalog names and the value object the aggregator reads.
		expect(stub).toContain("export const MORPH_MODELS: DisabledModelCatalog");
		expect(stub).toContain("export const MORPH_IMAGE_MODELS: DisabledModelCatalog");
		expect(stub).toContain("export const MORPH_CLASSIFIER_MODELS: DisabledModelCatalog");
		expect(stub).toContain("export const value = {");
		expect(existsSync(orphanPath)).toBe(false);
	});
});
