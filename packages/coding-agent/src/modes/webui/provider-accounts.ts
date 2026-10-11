/**
 * Provider-account endpoints for the webui, mapped onto `models.json`.
 *
 * The webui's "provider account" is one entry in the models.json `providers`
 * map: the vendor preset (or generic protocol) it speaks, the endpoint, the
 * key, and its models. Mutations rewrite the file; the caller refreshes
 * ModelRuntime so new models appear without a restart. API keys are written to
 * models.json (its documented `apiKey` field) and never returned to the page.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import { stripJsonComments } from "../../utils/json.ts";
import { stripBom } from "../../utils/text.ts";

/** Wire type from the webui frontend (see packages/webui/src/api.ts). */
export interface ProviderPresetInfo {
	id: string;
	display_name: string;
	type: string;
	default_base_url?: string;
	requires_api_key: boolean;
	model_source?: "embedded" | "discovery_api" | "manual";
	discoverable?: boolean;
}

/** Vendor presets: known services with their endpoint and key requirement. */
export const PROVIDER_PRESETS: readonly ProviderPresetInfo[] = [
	{
		id: "anthropic",
		display_name: "Anthropic",
		type: "anthropic",
		default_base_url: "https://api.anthropic.com",
		requires_api_key: true,
		discoverable: true,
	},
	{
		id: "openai",
		display_name: "OpenAI",
		type: "openai",
		default_base_url: "https://api.openai.com/v1",
		requires_api_key: true,
		discoverable: true,
	},
	{
		id: "openrouter",
		display_name: "OpenRouter",
		type: "openai",
		default_base_url: "https://openrouter.ai/api/v1",
		requires_api_key: true,
		discoverable: true,
	},
	{
		id: "deepseek",
		display_name: "DeepSeek",
		type: "openai",
		default_base_url: "https://api.deepseek.com/v1",
		requires_api_key: true,
		discoverable: true,
	},
	{
		id: "moonshot",
		display_name: "Moonshot AI",
		type: "openai",
		default_base_url: "https://api.moonshot.cn/v1",
		requires_api_key: true,
		discoverable: true,
	},
	{
		id: "zhipu",
		display_name: "Zhipu (GLM)",
		type: "openai",
		default_base_url: "https://open.bigmodel.cn/api/paas/v4",
		requires_api_key: true,
		discoverable: true,
	},
	{
		id: "ollama",
		display_name: "Ollama (local)",
		type: "openai",
		default_base_url: "http://localhost:11434/v1",
		requires_api_key: false,
		discoverable: true,
	},
	{
		id: "lmstudio",
		display_name: "LM Studio (local)",
		type: "openai",
		default_base_url: "http://localhost:1234/v1",
		requires_api_key: false,
		discoverable: true,
	},
];

/** Generic protocols for a custom endpoint. */
export const PROVIDER_PROTOCOLS: readonly ProviderPresetInfo[] = [
	{
		id: "openai-compatible",
		display_name: "OpenAI-compatible",
		type: "openai",
		default_base_url: "https://gateway.example/v1",
		requires_api_key: false,
		discoverable: true,
	},
	{
		id: "anthropic-compatible",
		display_name: "Anthropic-compatible",
		type: "anthropic",
		default_base_url: "https://gateway.example",
		requires_api_key: false,
		discoverable: true,
	},
];

/** Subset of models.json shapes this module reads and writes. */
interface ModelsJsonModel {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	input?: string[];
}

interface ModelsJsonProvider {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	models?: ModelsJsonModel[];
	[key: string]: unknown;
}

interface ModelsJsonFile {
	$schema?: string;
	providers: Record<string, ModelsJsonProvider>;
}

/** Wire type from the webui frontend (ProviderAccountInfo). */
export interface ProviderAccountView {
	id: string;
	provider: string;
	display_name?: string;
	type: string;
	base_url?: string;
	has_api_key: boolean;
	model_ids: string[];
	legacy: boolean;
	managed: boolean;
	label?: string;
	preset_name?: string;
	custom?: boolean;
	discoverable?: boolean;
	probeable?: boolean;
}

/** Model body from the webui (NewModelBody). */
export interface NewModelInput {
	model: string;
	display_name?: string;
	context_window?: number;
	max_tokens?: number;
	supports_vision?: boolean;
	reasoning_effort?: string;
}

export class ProviderAccountError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

export function providerAccountsPath(agentDir = getAgentDir()): string {
	return join(agentDir, "models.json");
}

async function readModelsJson(path: string): Promise<ModelsJsonFile> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch {
		return { providers: {} };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(stripBom(content)));
	} catch (error) {
		throw new ProviderAccountError(
			`models.json is not valid JSON: ${error instanceof Error ? error.message : error}`,
			500,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ProviderAccountError("models.json is not an object", 500);
	}
	const file = parsed as ModelsJsonFile;
	if (file.providers === undefined) return { ...file, providers: {} };
	if (typeof file.providers !== "object" || Array.isArray(file.providers)) {
		throw new ProviderAccountError('models.json "providers" is not an object', 500);
	}
	return file;
}

async function writeModelsJson(path: string, file: ModelsJsonFile): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
}

function modelToEntry(input: NewModelInput): ModelsJsonModel {
	const entry: ModelsJsonModel = { id: input.model };
	if (input.display_name) entry.name = input.display_name;
	if (input.context_window) entry.contextWindow = input.context_window;
	if (input.max_tokens) entry.maxTokens = input.max_tokens;
	if (input.supports_vision) entry.input = ["text", "image"];
	if (input.reasoning_effort) entry.reasoning = true;
	return entry;
}

function resolveChoice(provider: string): ProviderPresetInfo {
	const choice = [...PROVIDER_PRESETS, ...PROVIDER_PROTOCOLS].find((preset) => preset.id === provider);
	if (!choice) throw new ProviderAccountError(`unknown provider preset or protocol: ${provider}`, 400);
	return choice;
}

function checkAccountId(id: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
		throw new ProviderAccountError(
			`invalid account id "${id}": must start with a letter or digit and contain only letters, digits, . _ -`,
			400,
		);
	}
}

function toView(id: string, entry: ModelsJsonProvider): ProviderAccountView {
	const preset =
		PROVIDER_PRESETS.find((p) => p.id === id) ??
		PROVIDER_PRESETS.find((p) => p.type === entry.api && p.default_base_url === entry.baseUrl);
	const protocol = PROVIDER_PROTOCOLS.find((p) => p.type === entry.api);
	const choice = preset ?? protocol;
	return {
		id,
		provider: preset && preset.id === id ? preset.id : (protocol?.id ?? "openai-compatible"),
		display_name: entry.name,
		type: entry.api ?? "openai",
		base_url: entry.baseUrl,
		has_api_key: typeof entry.apiKey === "string" && entry.apiKey.length > 0,
		model_ids: (entry.models ?? []).map((model) => model.id),
		legacy: false,
		managed: false,
		label: entry.name ?? id,
		preset_name: preset && preset.id !== id ? preset.display_name : undefined,
		custom: !preset || preset.id !== id,
		discoverable: choice?.discoverable ?? true,
		probeable: Boolean(entry.baseUrl),
	};
}

export async function listAccounts(path: string): Promise<ProviderAccountView[]> {
	const file = await readModelsJson(path);
	return Object.entries(file.providers).map(([id, entry]) => toView(id, entry));
}

export interface CreateAccountInput {
	id?: string;
	provider: string;
	display_name?: string;
	base_url?: string;
	api_key?: string;
	models: NewModelInput[];
}

export async function createAccount(
	path: string,
	input: CreateAccountInput,
): Promise<{ account: string; models: string[] }> {
	const choice = resolveChoice(input.provider);
	const id = (input.id ?? input.provider).trim();
	checkAccountId(id);
	if (!input.models.length) throw new ProviderAccountError("at least one model is required", 400);
	if (input.models.some((model) => !model.model?.trim())) {
		throw new ProviderAccountError("every model needs an id", 400);
	}

	const file = await readModelsJson(path);
	if (file.providers[id]) throw new ProviderAccountError(`account "${id}" already exists`, 409);

	const baseUrl = (input.base_url?.trim() || choice.default_base_url || "").trim();
	if (choice.requires_api_key && !input.api_key?.trim()) {
		throw new ProviderAccountError(`${choice.display_name} requires an API key`, 400);
	}

	const entry: ModelsJsonProvider = { api: choice.type };
	if (input.display_name?.trim()) entry.name = input.display_name.trim();
	if (baseUrl) entry.baseUrl = baseUrl;
	if (input.api_key?.trim()) entry.apiKey = input.api_key.trim();
	entry.models = input.models.map(modelToEntry);

	file.providers[id] = entry;
	await writeModelsJson(path, file);
	return { account: id, models: entry.models.map((model) => model.id) };
}

export interface EditAccountInput {
	display_name?: string;
	base_url?: string;
	api_key?: string;
}

export async function editAccount(path: string, id: string, input: EditAccountInput): Promise<void> {
	const file = await readModelsJson(path);
	const entry = file.providers[id];
	if (!entry) throw new ProviderAccountError(`no such account: ${id}`, 404);
	if (input.display_name !== undefined) {
		const name = input.display_name.trim();
		if (name) entry.name = name;
		else delete entry.name;
	}
	if (input.base_url !== undefined) {
		const baseUrl = input.base_url.trim();
		if (baseUrl) entry.baseUrl = baseUrl;
		else delete entry.baseUrl;
	}
	// An omitted or empty key keeps the stored one; keys are never sent back.
	if (input.api_key?.trim()) entry.apiKey = input.api_key.trim();
	await writeModelsJson(path, file);
}

export async function deleteAccount(path: string, id: string): Promise<void> {
	const file = await readModelsJson(path);
	if (!file.providers[id]) throw new ProviderAccountError(`no such account: ${id}`, 404);
	delete file.providers[id];
	await writeModelsJson(path, file);
}

export async function addAccountModels(path: string, id: string, models: NewModelInput[]): Promise<string[]> {
	const file = await readModelsJson(path);
	const entry = file.providers[id];
	if (!entry) throw new ProviderAccountError(`no such account: ${id}`, 404);
	const existing = new Set((entry.models ?? []).map((model) => model.id));
	const created: string[] = [];
	for (const model of models) {
		if (!model.model?.trim()) throw new ProviderAccountError("every model needs an id", 400);
		if (existing.has(model.model)) continue;
		existing.add(model.model);
		entry.models = [...(entry.models ?? []), modelToEntry(model)];
		created.push(model.model);
	}
	await writeModelsJson(path, file);
	return created;
}

export interface EditModelInput {
	model?: string;
	display_name?: string;
	context_window?: number;
	max_tokens?: number;
	clear_max_tokens?: boolean;
	supports_vision?: boolean;
	clear_supports_vision?: boolean;
	reasoning_effort?: string;
	clear_reasoning_effort?: boolean;
}

export async function editAccountModel(
	path: string,
	id: string,
	modelId: string,
	input: EditModelInput,
): Promise<void> {
	const file = await readModelsJson(path);
	const entry = file.providers[id];
	const model = entry?.models?.find((candidate) => candidate.id === modelId);
	if (!model) throw new ProviderAccountError(`no such model: ${id}/${modelId}`, 404);
	if (input.display_name !== undefined) {
		const name = input.display_name.trim();
		if (name) model.name = name;
		else delete model.name;
	}
	if (input.context_window) model.contextWindow = input.context_window;
	if (input.max_tokens) model.maxTokens = input.max_tokens;
	if (input.clear_max_tokens) delete model.maxTokens;
	if (input.supports_vision !== undefined) model.input = ["text", "image"];
	if (input.clear_supports_vision) delete model.input;
	if (input.reasoning_effort) model.reasoning = true;
	if (input.clear_reasoning_effort) delete model.reasoning;
	await writeModelsJson(path, file);
}

export async function deleteAccountModel(path: string, id: string, modelId: string): Promise<void> {
	const file = await readModelsJson(path);
	const entry = file.providers[id];
	if (!entry?.models) throw new ProviderAccountError(`no such model: ${id}/${modelId}`, 404);
	const next = entry.models.filter((model) => model.id !== modelId);
	if (next.length === entry.models.length) {
		throw new ProviderAccountError(`no such model: ${id}/${modelId}`, 404);
	}
	entry.models = next;
	await writeModelsJson(path, file);
}

export interface DiscoveredModel {
	id: string;
	name?: string;
}

/** List models from the endpoint: `/models` (OpenAI-compatible) or `/v1/models` (Anthropic). */
export async function discoverModels(input: {
	type: string;
	base_url: string;
	api_key?: string;
}): Promise<DiscoveredModel[]> {
	const baseUrl = input.base_url.trim().replace(/\/+$/, "");
	if (!baseUrl) throw new ProviderAccountError("base_url is required", 400);
	const url = input.type === "anthropic" ? `${baseUrl}/v1/models` : `${baseUrl}/models`;
	const headers: Record<string, string> = {};
	if (input.api_key) {
		if (input.type === "anthropic") {
			headers["x-api-key"] = input.api_key;
			headers["anthropic-version"] = "2023-06-01";
		} else {
			headers.Authorization = `Bearer ${input.api_key}`;
		}
	}
	let response: Response;
	try {
		response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
	} catch (error) {
		throw new ProviderAccountError(`could not reach ${url}: ${error instanceof Error ? error.message : error}`, 502);
	}
	if (!response.ok) {
		throw new ProviderAccountError(`${url} answered ${response.status}`, 502);
	}
	const payload = (await response.json()) as { data?: Array<{ id?: string; display_name?: string }> };
	const models = Array.isArray(payload.data) ? payload.data : [];
	return models
		.filter((model): model is { id: string; display_name?: string } => typeof model.id === "string")
		.map((model) => ({ id: model.id, name: model.display_name }));
}
