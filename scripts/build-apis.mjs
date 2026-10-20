/**
 * esbuild wiring for the `apis` and `providers` entries of buildconfig.json.
 *
 * Both used to be runtime filters only:
 *
 * - `apis`: compat.ts registers a subset (`BUILTIN_APIS` + `isApiIncluded`), but
 *   the `.lazy` module behind every dropped API stays in the graph, and so does
 *   the client SDK it imports (`@google/genai`, the AWS, Anthropic and OpenAI
 *   packages).
 * - `providers`: model-runtime.ts filters `builtinProviders()`, but the catalog
 *   shards are static imports of `models.generated.ts`, so every provider's
 *   model data stays in the bundle.
 *
 * This plugin aliases both kinds of module at resolve time:
 *
 * - `<api>.lazy.ts` and the images implementation module
 *   (`openrouter-images.ts`, which the images registration imports directly)
 *   become `packages/ai/src/api/disabled/<api>-disabled.ts`,
 * - `<provider>.models.ts` becomes `packages/ai/src/providers/disabled/<provider>-models.ts`.
 *
 * Both stand-ins keep the export names and shapes of the modules they replace:
 * `validateStubExports` compares them before the bundle is written, so a drift
 * fails the build with the file to fix instead of an esbuild "no matching
 * export" error.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ALL_APIS, ALL_PROVIDERS } from "./buildconfig.mjs";

/** Suffixes of the generated modules and of their stand-ins. */
const LAZY_SUFFIX = ".lazy.ts";
const MODELS_SUFFIX = ".models.ts";
const DISABLED_SUFFIX = "-disabled.ts";
const DISABLED_MODELS_SUFFIX = "-models.ts";
const API_STUB_DIR = "src/api/disabled";
const PROVIDER_STUB_DIR = "src/providers/disabled";

/** API ids with a module under packages/ai/src/api. */
export function readApiModuleIds(aiDir) {
	return readdirSync(join(aiDir, "src", "api"))
		.filter((entry) => entry.endsWith(LAZY_SUFFIX))
		.map((entry) => entry.slice(0, -LAZY_SUFFIX.length))
		.sort();
}

/**
 * Implementation modules a dropped `.lazy.ts` wrapper is the only reference to.
 * `bedrock-provider.ts` imports these directly for the single-file build, which
 * cannot follow a variable-specifier import, so the wrapper alone is not enough:
 * leaving them out is what keeps the AWS SDK and the Bedrock code path out of a
 * single-endpoint build.
 */
const API_IMPLEMENTATIONS = {
	"bedrock-converse-stream": "bedrock-converse-stream.ts",
	"bedrock-mantle-anthropic-messages": "bedrock-mantle-anthropic-messages.ts",
	"bedrock-mantle-openai-responses": "bedrock-mantle-openai-responses.ts",
};

/** Provider ids with a generated catalog under packages/ai/src/providers. */
export function readProviderModuleIds(aiDir) {
	return readdirSync(join(aiDir, "src", "providers"))
		.filter((entry) => entry.endsWith(MODELS_SUFFIX))
		.map((entry) => entry.slice(0, -MODELS_SUFFIX.length))
		.sort();
}

/** Export names declared by a module (values only: types erase). */
function exportedValueNames(source) {
	const names = new Set();
	for (const match of source.matchAll(/^export (?:async )?(?:function|const|class)\s+([A-Za-z0-9_$]+)/gm)) {
		names.add(match[1]);
	}
	return names;
}

/**
 * Module inside packages/ai/src for one API id. Everything is a `.lazy.ts`
 * wrapper, except `openrouter-images`: the images registration
 * (`providers/images/register-builtins.ts`) imports the implementation module
 * itself, so that is the one the stand-in replaces.
 */
function apiModulePath(apiId) {
	return apiId === "openrouter-images" ? `api/${apiId}.ts` : `api/${apiId}${LAZY_SUFFIX}`;
}

function assertStubs({ aiDir, ids, stubDir, sourcePath, stubSuffix, label }) {
	const details = [];
	const stubIds = new Set(
		readdirSync(join(aiDir, stubDir))
			.filter((entry) => entry.endsWith(stubSuffix))
			.map((entry) => entry.slice(0, -stubSuffix.length)),
	);
	for (const id of ids) {
		if (!stubIds.has(id)) {
			details.push(`${id}: no ${stubDir}/${id}${stubSuffix}`);
			continue;
		}
		const sourceNames = exportedValueNames(readFileSync(join(aiDir, "src", sourcePath(id)), "utf8"));
		const stubNames = exportedValueNames(readFileSync(join(aiDir, stubDir, `${id}${stubSuffix}`), "utf8"));
		const missing = [...sourceNames].filter((name) => !stubNames.has(name));
		if (missing.length > 0) details.push(`${id}: stub is missing ${missing.join(", ")}`);
	}
	if (details.length > 0) {
		throw new Error(`${label} under packages/ai/${stubDir} are out of sync: ${details.join("; ")}`);
	}
}

/**
 * Throws when an API or provider has no stand-in, or a stand-in stopped
 * exporting something its module exports. A missing name is an esbuild error
 * deep inside a release build; this reports the same thing with the file to
 * add it to.
 */
export function validateStubs(aiDir) {
	assertStubs({
		aiDir,
		ids: readApiModuleIds(aiDir),
		stubDir: API_STUB_DIR,
		sourcePath: (apiId) => apiModulePath(apiId),
		stubSuffix: DISABLED_SUFFIX,
		label: "API stubs",
	});
	assertStubs({
		aiDir,
		ids: readProviderModuleIds(aiDir),
		stubDir: PROVIDER_STUB_DIR,
		sourcePath: (providerId) => `providers/${providerId}${MODELS_SUFFIX}`,
		stubSuffix: DISABLED_MODELS_SUFFIX,
		label: "provider stubs",
	});
}

/**
 * Builds the plugin plus the ids it replaced.
 *
 * @param {{ aiDir: string, apis: readonly string[], builtinProviderIds: readonly string[] | undefined }} options
 *   `apis` is the resolved API set (`["__ALL__"]` leaves every module alone);
 *   `builtinProviderIds` is undefined for a build that ships every catalog.
 * @returns {{ plugin: import("esbuild").Plugin, disabledApis: string[], disabledProviders: string[] }}
 */
export function createApiStubPlugin({ aiDir, apis, builtinProviderIds }) {
	const disabledApis = apis.includes(ALL_APIS) ? [] : readApiModuleIds(aiDir).filter((id) => !apis.includes(id));
	const shippedProviders = builtinProviderIds === undefined ? undefined : new Set(builtinProviderIds);
	const disabledProviders =
		shippedProviders === undefined
			? []
			: readProviderModuleIds(aiDir).filter((id) => !shippedProviders.has(id));
	if (disabledApis.length === 0 && disabledProviders.length === 0) {
		return { plugin: inertPlugin(), disabledApis: [], disabledProviders: [] };
	}

	// Keyed by the compiled module path an import resolves to: the same module is
	// imported as `./openai-responses.lazy.js` from dist/api and as
	// `@nanopi/pi-ai/api/openai-responses.lazy` from the coding-agent.
	const stubs = new Map();
	for (const apiId of disabledApis) {
		const stub = join(aiDir, "dist", "api", "disabled", `${apiId}${DISABLED_SUFFIX.replace(/\.ts$/, ".js")}`);
		stubs.set(join(aiDir, "dist", apiModulePath(apiId).replace(/\.ts$/, "")), stub);
		const implementation = API_IMPLEMENTATIONS[apiId];
		if (implementation !== undefined) {
			stubs.set(join(aiDir, "dist", "api", implementation.replace(/\.ts$/, "")), stub);
		}
	}
	for (const providerId of disabledProviders) {
		stubs.set(
			join(aiDir, "dist", "providers", `${providerId}${MODELS_SUFFIX.replace(/\.ts$/, "")}`),
			join(
				aiDir,
				"dist",
				"providers",
				"disabled",
				`${providerId}${DISABLED_MODELS_SUFFIX.replace(/\.ts$/, ".js")}`,
			),
		);
	}

	return {
		plugin: {
			name: "builtin-api-and-catalog-stubs",
			setup(build) {
				build.onResolve({ filter: /.*/ }, (args) => {
					const stub = stubs.get(resolveModulePath(args, aiDir));
					return stub === undefined ? undefined : { path: stub };
				});
			},
		},
		disabledApis,
		disabledProviders,
	};
}

/**
 * Absolute path an import names, with the extension dropped like the map key.
 * Relative specifiers resolve against the importer, which esbuild provides
 * until the plugin claims the import.
 */
function resolveModulePath(args, aiDir) {
	if (args.path.startsWith("@nanopi/pi-ai/api/") || args.path.startsWith("@nanopi/pi-ai/providers/")) {
		return join(aiDir, "dist", args.path.slice("@nanopi/pi-ai/".length));
	}
	if (!args.path.startsWith(".")) return undefined;
	const joined = join(args.resolveDir ?? aiDir, args.path);
	return joined.endsWith(".js") ? joined.slice(0, -3) : joined;
}

function inertPlugin() {
	return { name: "builtin-api-and-catalog-stubs", setup() {} };
}

/** Re-exported for the tests that cross-check the sets against buildconfig.json. */
export const BUILD_MARKERS = { ALL_APIS, ALL_PROVIDERS };
