import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const MODEL_DATA_SCHEMA_VERSION = 6;
export const MODEL_DATA_MANIFEST_FILE = ".manifest.json";
/**
 * Aggregator comment a no-provider build writes, so an empty catalog is a
 * recorded decision rather than a truncated file.
 */
export const EMPTY_CATALOG_MARKER = "// no-builtin-providers";

export type ModelDataStructure = Record<string, Record<string, string>>;

/**
 * The stamp a build writes next to the provider data. It carries no per-file
 * hashes: the catalog files are validated against the structure the aggregator
 * declares (`validateModelDataDirectory`), and the build compares the stamp
 * itself to the staged directory it just wrote. A hash table here would be
 * bundled into the single-file artifact, where nothing reads it.
 */
export interface ModelDataManifest {
	schemaVersion: number;
	generatedAt: string;
	structureHash: string;
}

const MODEL_DATA_IMPORT_PATTERN =
	/^import \{ [A-Z][A-Z0-9_]*_CLASSIFIER_MODELS, [A-Z][A-Z0-9_]*_IMAGE_MODELS, [A-Z][A-Z0-9_]*_MODELS \} from "\.\/providers\/([^"/]+)\.models\.ts";$/gm;
const MODEL_DATA_PROVIDER_ID_PATTERN = /^\/\/ provider-id: (.+)$/gm;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
	return Object.fromEntries(Array.from(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function describeSetDifference(expected: readonly string[], actual: readonly string[]): string {
	const expectedSet = new Set(expected);
	const actualSet = new Set(actual);
	const missing = expected.filter((value) => !actualSet.has(value));
	const extra = actual.filter((value) => !expectedSet.has(value));
	return [missing.length > 0 ? `missing: ${missing.join(", ")}` : "", extra.length > 0 ? `extra: ${extra.join(", ")}` : ""]
		.filter(Boolean)
		.join("; ");
}

export function assertExactModelIds(label: string, expected: Iterable<string>, actual: Iterable<string>): void {
	const expectedIds = Array.from(new Set(expected)).sort();
	const actualIds = Array.from(new Set(actual)).sort();
	if (sameStrings(expectedIds, actualIds)) return;
	throw new Error(`${label} model IDs do not match (${describeSetDifference(expectedIds, actualIds)})`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModalityList(value: unknown): value is ("text" | "image")[] {
	return Array.isArray(value) && value.length > 0 && value.every((entry) => entry === "text" || entry === "image");
}

function readJsonObject(path: string, description: string, errors: string[]): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`${description} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	if (!isRecord(parsed)) {
		errors.push(`${description} must contain a JSON object`);
		return undefined;
	}
	return parsed;
}

/**
 * Provider ids may contain dots (`llama.cpp`), but their generated module and
 * data file names replace them with dashes so they stay importable.
 */
export function providerArtifactName(providerId: string): string {
	return providerId.replace(/\./g, "-");
}

function readProviderStructure(path: string, providerId: string): Record<string, string> {
	const errors: string[] = [];
	const groups = readJsonObject(path, `${providerId}.json`, errors);
	if (!groups) throw new Error(errors.join("\n"));

	const models = new Map<string, string>();
	for (const [api, value] of Object.entries(groups)) {
		if (!isRecord(value)) throw new Error(`${path} API group ${JSON.stringify(api)} must be an object`);
		for (const modelKey of Object.keys(value)) {
			if (models.has(modelKey)) throw new Error(`${path} contains ${modelKey} in more than one API group`);
			models.set(modelKey, api);
		}
	}
	// An empty object is the valid shape of a provider with no model of that
	// kind; a file without any group is the one that cannot have been generated.
	if (Object.keys(groups).length === 0) throw new Error(`${path} contains no API group`);
	return sortedRecord(models);
}

/**
 * Provider ids of the checkout's generated catalog.
 *
 * The aggregator is the record when it exists. A clean checkout does not have
 * it (the generator writes it on every build, and it is gitignored), so the
 * provider data directory becomes the record instead: the manifest lists every
 * provider file. The structure derived from those files is validated entry by
 * entry anyway, so reading it does not trust a file that was never checked.
 */
export function readModelDataProviderIds(packageRoot: string): string[] {
	const aggregatorPath = join(packageRoot, "src", "models.generated.ts");
	if (!existsSync(aggregatorPath)) {
		return readDataDirectoryProviderIds(join(packageRoot, "src", "providers", "data"));
	}
	const aggregator = readFileSync(aggregatorPath, "utf8");
	// Module names lose dots (`llama.cpp` → `llama-cpp`), so prefer the ids the
	// generator recorded next to each import.
	const recordedIds = Array.from(aggregator.matchAll(MODEL_DATA_PROVIDER_ID_PATTERN), (match) => match[1]);
	const providerIds = (recordedIds.length > 0
		? recordedIds
		: Array.from(aggregator.matchAll(MODEL_DATA_IMPORT_PATTERN), (match) => match[1])
	).sort();
	if (providerIds.length === 0) {
		// A flavor with no provider builds an empty catalog on purpose, so zero
		// imports are valid when the aggregator says so: the structure is empty,
		// and the shards and data files must be gone too.
		if (!aggregator.includes(EMPTY_CATALOG_MARKER)) {
			throw new Error(`No generated provider imports found in ${aggregatorPath}`);
		}
		return [];
	}
	if (new Set(providerIds).size !== providerIds.length) {
		throw new Error(`Generated model aggregator contains duplicate provider imports: ${aggregatorPath}`);
	}
	return providerIds;
}

/**
 * The provider ids a data-only run has to write, or undefined when the checkout
 * has no generated catalog to narrow. A release checkout is fresh — the
 * aggregator and the data files are build products — so there is nothing to
 * preserve and the run writes every provider the build carries.
 */
export function findGeneratedModelDataProviderIds(packageRoot: string): string[] | undefined {
	const aggregatorPath = join(packageRoot, "src", "models.generated.ts");
	const dataDir = join(packageRoot, "src", "providers", "data");
	if (!existsSync(aggregatorPath) && !existsSync(dataDir)) return undefined;
	return readModelDataProviderIds(packageRoot);
}

/**
 * Provider ids named by the data files of a generated data directory. The
 * manifest is not consulted: it records the structure hash only, so the files
 * on disk are the record of which providers the last run wrote.
 */
function readDataDirectoryProviderIds(dataDir: string): string[] {
	if (!existsSync(dataDir)) {
		throw new Error(`No generated model data found: ${dataDir} (run \`pnpm run generate:models\`)`);
	}
	return readdirSync(dataDir)
		.filter((entry) => entry.endsWith(".json") && entry !== MODEL_DATA_MANIFEST_FILE)
		.map((entry) => entry.slice(0, -".json".length))
		.sort();
}

/**
 * The generated shard names next to the data directory. They are build products
 * too, so a checkout without them is listed rather than rejected: the shard set
 * is only checked when it exists, which is what `validateGeneratedModelData`
 * does after the generator or the build wrote it.
 */
function readProviderShardNames(providersDir: string): string[] {
	if (!existsSync(providersDir)) return [];
	return readdirSync(providersDir)
		.filter((entry) => entry.endsWith(".models.ts"))
		.sort();
}

export function readModelDataStructure(packageRoot: string): ModelDataStructure {
	const providersDir = join(packageRoot, "src", "providers");
	const dataDir = join(providersDir, "data");
	const providerIds = readModelDataProviderIds(packageRoot);
	const expectedShards = providerIds
		.map((providerId) => `${providerArtifactName(providerId)}.models.ts`)
		.sort();
	const actualShards = readProviderShardNames(providersDir);
	if (actualShards.length > 0 && !sameStrings(expectedShards, actualShards)) {
		throw new Error(
			`Generated model aggregator and provider shards do not match (${describeSetDifference(expectedShards, actualShards)})`,
		);
	}

	return sortedRecord(
		providerIds.map((providerId) => [
			providerId,
			readProviderStructure(join(dataDir, `${providerArtifactName(providerId)}.json`), providerId),
		]),
	);
}

export function modelDataStructureHash(structure: ModelDataStructure): string {
	const normalized = sortedRecord(
		Object.entries(structure).map(
			([providerId, models]) => [providerId, sortedRecord(Object.entries(models))] as const,
		),
	);
	return sha256(JSON.stringify(normalized));
}

export function createModelDataManifest(structure: ModelDataStructure, generatedAt: string): ModelDataManifest {
	return {
		schemaVersion: MODEL_DATA_SCHEMA_VERSION,
		generatedAt,
		structureHash: modelDataStructureHash(structure),
	};
}

function validateModelValue(
	value: unknown,
	dataFileProviderId: string,
	expectedProviderId: string,
	modelId: string,
	expectedApi: string,
	errors: string[],
): void {
	const label = `${dataFileProviderId}/${modelId}`;
	if (!isRecord(value)) {
		errors.push(`${label} must be an object`);
		return;
	}
	if (value.id !== modelId) errors.push(`${label} has id ${JSON.stringify(value.id)}, expected ${JSON.stringify(modelId)}`);
	if (value.provider !== expectedProviderId) {
		errors.push(`${label} has provider ${JSON.stringify(value.provider)}, expected ${JSON.stringify(expectedProviderId)}`);
	}
	if (value.api !== expectedApi) {
		errors.push(`${label} has api ${JSON.stringify(value.api)}, expected ${JSON.stringify(expectedApi)}`);
	}
	if (typeof value.name !== "string" || value.name.length === 0) errors.push(`${label} has no model name`);
	if (typeof value.baseUrl !== "string") errors.push(`${label} has no baseUrl string`);
	if (!isModalityList(value.input)) errors.push(`${label} has invalid input modalities`);
	if (value.type === "image") {
		if (!isModalityList(value.output) || !value.output.includes("image")) {
			errors.push(`${label} has invalid output modalities`);
		}
	} else if (value.output !== undefined) {
		errors.push(`${label} has unsupported output modalities`);
	}
	if (value.type === "chat") {
		if (typeof value.reasoning !== "boolean") errors.push(`${label} has no reasoning boolean`);
		if (
			typeof value.contextWindow !== "number" ||
			!Number.isFinite(value.contextWindow) ||
			value.contextWindow <= 0
		) {
			errors.push(`${label} has invalid contextWindow`);
		}
		if (typeof value.maxTokens !== "number" || !Number.isFinite(value.maxTokens) || value.maxTokens <= 0) {
			errors.push(`${label} has invalid maxTokens`);
		}
	} else if (value.type === "classifier") {
		if (
			typeof value.contextWindow !== "number" ||
			!Number.isFinite(value.contextWindow) ||
			value.contextWindow <= 0
		) {
			errors.push(`${label} has invalid contextWindow`);
		}
	} else if (value.type !== "image") {
		errors.push(`${label} has type ${JSON.stringify(value.type)}, expected "chat", "image", or "classifier"`);
	}
	if (!isRecord(value.cost)) {
		errors.push(`${label} has invalid cost metadata`);
	} else {
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const cost = value.cost[field];
			if (typeof cost !== "number" || !Number.isFinite(cost)) {
				errors.push(`${label} has invalid cost.${field}`);
			}
		}
	}
}

function throwValidationErrors(errors: string[]): never {
	const visible = errors.slice(0, 30);
	const suffix = errors.length > visible.length ? `\n  ... and ${errors.length - visible.length} more` : "";
	throw new Error(`Invalid generated model data:\n${visible.map((error) => `  - ${error}`).join("\n")}${suffix}`);
}

export function validateModelDataDirectory(structure: ModelDataStructure, dataDir: string): void {
	if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
		throw new Error(`Generated model data directory does not exist: ${dataDir}`);
	}

	const errors: string[] = [];
	const expectedFiles = Object.keys(structure)
		.map((providerId) => `${providerArtifactName(providerId)}.json`)
		.sort();
	const actualFiles = readdirSync(dataDir)
		.filter((entry) => entry.endsWith(".json") && entry !== MODEL_DATA_MANIFEST_FILE)
		.sort();
	if (!sameStrings(expectedFiles, actualFiles)) {
		errors.push(`provider data files do not match the generated catalog (${describeSetDifference(expectedFiles, actualFiles)})`);
	}

	const manifestPath = join(dataDir, MODEL_DATA_MANIFEST_FILE);
	const manifest = readJsonObject(manifestPath, "model data manifest", errors);
	if (manifest?.schemaVersion !== MODEL_DATA_SCHEMA_VERSION) {
		errors.push(
			`model data schema is ${JSON.stringify(manifest?.schemaVersion)}, expected ${MODEL_DATA_SCHEMA_VERSION}`,
		);
	}
	if (typeof manifest?.generatedAt !== "string" || Number.isNaN(Date.parse(manifest.generatedAt))) {
		errors.push("model data manifest has an invalid generation timestamp");
	}
	const expectedStructureHash = modelDataStructureHash(structure);
	if (manifest?.structureHash !== expectedStructureHash) {
		errors.push("model data generation stamp does not match the generated catalog");
	}
	for (const [providerId, expectedModels] of Object.entries(structure)) {
		const filename = `${providerArtifactName(providerId)}.json`;
		const path = join(dataDir, filename);
		if (!existsSync(path)) continue;
		const groups = readJsonObject(path, filename, errors);
		if (!groups) continue;

		const actualModels = new Map<string, string>();
		for (const [api, value] of Object.entries(groups)) {
			if (!isRecord(value)) {
				errors.push(`${filename} API group ${JSON.stringify(api)} must be an object`);
				continue;
			}
			for (const [modelKey, model] of Object.entries(value)) {
				if (actualModels.has(modelKey)) {
					errors.push(`${providerId}/${modelKey} appears in more than one API group`);
					continue;
				}
				actualModels.set(modelKey, api);
				const separator = modelKey.indexOf(":");
				const modelId = separator >= 0 ? modelKey.slice(separator + 1) : modelKey;
				validateModelValue(model, providerArtifactName(providerId), providerId, modelId, api, errors);
				if (isRecord(model) && modelKey !== `${String(model.type)}:${String(model.id)}`) {
					errors.push(`${providerId}/${modelKey} has mismatched type/id identity`);
				}
			}
		}

		const expectedModelIds = Object.keys(expectedModels).sort();
		const actualModelIds = Array.from(actualModels.keys()).sort();
		if (!sameStrings(expectedModelIds, actualModelIds)) {
			errors.push(`${filename} model IDs do not match the generated catalog (${describeSetDifference(expectedModelIds, actualModelIds)})`);
		}
		for (const [modelId, expectedApi] of Object.entries(expectedModels)) {
			const actualApi = actualModels.get(modelId);
			if (actualApi !== undefined && actualApi !== expectedApi) {
				errors.push(
					`${providerId}/${modelId} is grouped under API ${JSON.stringify(actualApi)}, expected ${JSON.stringify(expectedApi)}`,
				);
			}
		}
	}

	if (errors.length > 0) throwValidationErrors(errors);
}

export function validateGeneratedModelData(packageRoot: string): void {
	const structure = readModelDataStructure(packageRoot);
	validateModelDataDirectory(structure, join(packageRoot, "src", "providers", "data"));
}

export interface ModelCatalogEntry {
	type: string;
	id: string;
	api: string;
}

/**
 * Group one provider's typed catalog entries by API and key them by `type:id`,
 * the layout of `src/providers/data/<provider>.json`.
 */
export function groupProviderModelData<T extends ModelCatalogEntry>(
	providerId: string,
	models: readonly T[],
): { groups: Record<string, Record<string, T>>; structure: Record<string, string> } {
	const groups: Record<string, Record<string, T>> = {};
	const structure: Record<string, string> = {};
	for (const api of Array.from(new Set(models.map((model) => model.api))).sort()) {
		const group: Record<string, T> = {};
		for (const model of models) {
			if (model.api !== api) continue;
			const identity = `${model.type}:${model.id}`;
			if (group[identity]) throw new Error(`${providerId}/${identity} has duplicate ${api} catalog entries`);
			group[identity] = model;
			structure[identity] = api;
		}
		groups[api] = group;
	}
	return { groups, structure };
}

/**
 * Chat protocols served under the shared `openai` family route of a
 * path-routed gateway (OpenCode Zen's `/inference`): chat completions and
 * Responses both live at `<base>/openai/v1`, so both need the `openai`
 * segment added to a base URL that stops at the gateway root.
 */
const OPENAI_FAMILY_APIS = new Set<string>(["openai-completions", "openai-responses"]);

/**
 * Base URL to ship for one catalog entry.
 *
 * `basePath` is the catalog's own base URL, built for `<basePath>/v1` routing.
 * A gateway that routes per provider family publishes the served URL per model
 * (OpenCode Zen's `.../inference/openai/v1`, `.../inference/anthropic/v1`,
 * `.../inference/google/v1beta`); `publishedBaseUrl` carries it and wins, so a
 * route the gateway serves verbatim is never guessed.
 *
 * Without one, `familyRoutes` says whether the gateway needs the added segment:
 * Zen's `/inference` does — `<base>/v1/chat/completions` answers 404 while
 * `<base>/openai/v1/chat/completions` answers 429, the route matched — and its
 * 1.x `/zen` lane does not, so the flag travels with the lane rather than the
 * api. Chat completions and Responses share the `openai` family route;
 * Anthropic and Google already carry theirs in `basePath`.
 */
export function resolveCatalogBaseUrl(
	api: string,
	basePath: string,
	publishedBaseUrl: string | undefined,
	familyRoutes: boolean,
): string {
	const resolved = publishedBaseUrl ?? fallbackBaseUrl(api, basePath, familyRoutes);
	if (api !== "anthropic-messages") return resolved;
	// The Anthropic SDK posts to `<baseURL>/v1/messages` itself, so its base URL
	// must stop one segment below the route the gateway publishes
	// (`.../anthropic/v1` → `.../anthropic`); the stored form keeps the same
	// shape every other provider's base URL has.
	return resolved.replace(/\/v1$/, "");
}

function fallbackBaseUrl(api: string, basePath: string, familyRoutes: boolean): string {
	if (!familyRoutes) return basePath;
	if (OPENAI_FAMILY_APIS.has(api)) return basePath.replace(/\/(v1|v1beta)$/, "/openai/$1");
	return basePath;
}
