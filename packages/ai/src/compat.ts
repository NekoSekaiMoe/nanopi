/**
 * Temporary compatibility entrypoint preserving the old global pi-ai API
 * surface: api-dispatch `stream()`/`complete()` with env API key injection,
 * the api-registry, generated catalog reads (`getModel`/`getModels`/
 * `getProviders`), per-API lazy stream wrappers, and image generation.
 *
 * Existing apps switch imports from "@nanopi/pi-ai" to
 * "@nanopi/pi-ai/compat" unchanged; new code uses `createModels()`
 * and the provider factories. This module is deleted with the coding-agent
 * ModelManager migration.
 */

export * from "./api/anthropic-messages.lazy.ts";
export * from "./api/azure-openai-responses.lazy.ts";
export * from "./api/bedrock-converse-stream.lazy.ts";
export * from "./api/bedrock-mantle-anthropic-messages.lazy.ts";
export * from "./api/bedrock-mantle-openai-responses.lazy.ts";
export * from "./api/google-generative-ai.lazy.ts";
export * from "./api/google-vertex.lazy.ts";
export * from "./api/nanopi-messages.lazy.ts";
export * from "./api/openai-codex-responses.lazy.ts";
export * from "./api/openai-completions.lazy.ts";
export * from "./api/openai-responses.lazy.ts";
export * from "./api/qoder.lazy.ts";
export * from "./env-api-keys.ts";
export * from "./image-models.ts";
export * from "./images.ts";
export * from "./images-api-registry.ts";
export * from "./index.ts";
export * from "./legacy-api-aliases.ts";
// `providers/faux.ts` left the core entry above when the folder-island budget was enforced, so the
// compat entry re-exports it by hand: the generated `.d.ts` this module carries stays the same.
export * from "./providers/faux.ts";
export * from "./providers/images/register-builtins.ts";

import { anthropicMessagesApi } from "./api/anthropic-messages.lazy.ts";
import { azureOpenAIResponsesApi } from "./api/azure-openai-responses.lazy.ts";
import { bedrockConverseStreamApi } from "./api/bedrock-converse-stream.lazy.ts";
import { googleGenerativeAIApi } from "./api/google-generative-ai.lazy.ts";
import { googleVertexApi } from "./api/google-vertex.lazy.ts";
import { nanopiMessagesApi } from "./api/nanopi-messages.lazy.ts";
import { openAICodexResponsesApi } from "./api/openai-codex-responses.lazy.ts";
import { openAICompletionsApi } from "./api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "./api/openai-responses.lazy.ts";
import { qoderApi } from "./api/qoder.lazy.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
import type { ModelsApiStreamOptions } from "./models.ts";
import { builtinModels, getBuiltinModel, getBuiltinModels, getBuiltinProviders } from "./providers/all.ts";

export type { BuiltinProvider } from "./providers/all.ts";

import { registerFauxProvider } from "./providers/faux.ts";
import type {
	Api,
	ApiStreamOptions,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	ProviderStreams,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.ts";
import { normalizeContext } from "./utils/transcript.ts";

/** @deprecated Static catalog read. Use `getBuiltinModel` from "@nanopi/pi-ai/providers/all" or `Models.getModel()`. */
export const getModel = getBuiltinModel;

/** @deprecated Static catalog read. Use `getBuiltinModels` from "@nanopi/pi-ai/providers/all" or `Models.getModels()`. */
export const getModels = getBuiltinModels;

/** @deprecated Static catalog read. Use `getBuiltinProviders` from "@nanopi/pi-ai/providers/all" or `Models.getProviders()`. */
export const getProviders = getBuiltinProviders;

// The api-id registry moved to `api-proxy-registry.ts` so the faux provider can register itself
// without loading this module's catalog and env lookups. Re-exported: the shape of this entry and
// the `.d.ts` it produces are unchanged.
export * from "./api-proxy-registry.ts";

import { clearApiProviders, getApiProvider, registerApiProvider } from "./api-proxy-registry.ts";

// Moved to `providers/faux.ts` for the same reason.
export { registerFauxProvider };

/**
 * API ids this build carries, injected by the bundle and single-file build
 * scripts from buildconfig.json `apiSets`. Absent (or the string "undefined",
 * which is how the define map spells a full set) in source checkouts and npm
 * installs, which ship every implementation.
 *
 * The build also aliases the `.lazy` module of every API outside its set to a
 * stand-in (scripts/build-apis.mjs), so this filter is what keeps the registry
 * truthful rather than what keeps the code out.
 */
declare const NANOPI_BUILD_APIS: string[] | undefined;

/** The API ids this build registers, or undefined when it registers every one. */
export function builtinApiIds(): readonly string[] | undefined {
	if (typeof NANOPI_BUILD_APIS === "undefined" || (NANOPI_BUILD_APIS as unknown) === "undefined") return undefined;
	return NANOPI_BUILD_APIS;
}

/** Whether this build carries an API implementation. */
export function isApiIncluded(api: Api): boolean {
	const included = builtinApiIds();
	return included === undefined || included.includes("__ALL__") || included.includes(api);
}

const BUILTIN_APIS: [Api, ProviderStreams][] = [
	["anthropic-messages", anthropicMessagesApi()],
	["openai-completions", openAICompletionsApi()],
	["openai-responses", openAIResponsesApi()],
	["openai-codex-responses", openAICodexResponsesApi()],
	["azure-openai-responses", azureOpenAIResponsesApi()],
	["google-generative-ai", googleGenerativeAIApi()],
	["google-vertex", googleVertexApi()],
	["bedrock-converse-stream", bedrockConverseStreamApi()],
	["nanopi-messages", nanopiMessagesApi()],
	["qoder", qoderApi()],
];

const builtinApiProviderInstances = new Map<Api, ReturnType<typeof getApiProvider>>();

/**
 * Registers the builtin API implementations into the api-registry without
 * clobbering existing entries: compat may load after a test or extension has
 * already registered an override for a builtin api id.
 */
export function registerBuiltInApiProviders(): void {
	for (const [api, streams] of BUILTIN_APIS) {
		// A build that ships an API subset registers only that subset: models.json
		// can reference nothing else, and the other clients' lazy imports are
		// dead code the bundler drops.
		if (!isApiIncluded(api)) continue;
		if (!getApiProvider(api)) {
			registerApiProvider({ api, stream: streams.stream, streamSimple: streams.streamSimple });
		}
		builtinApiProviderInstances.set(api, getApiProvider(api));
	}
}

export function resetApiProviders(): void {
	clearApiProviders();
	builtinApiProviderInstances.clear();
	registerBuiltInApiProviders();
}

registerBuiltInApiProviders();

const compatModels = builtinModels();
const AMBIENT_AUTH_MARKER = "<authenticated>";

function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function withEnvApiKey<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	if (hasExplicitApiKey(options?.apiKey)) return options;
	const apiKey = getEnvApiKey(model.provider, options?.env);
	if (!apiKey || apiKey === AMBIENT_AUTH_MARKER) return options;
	return { ...options, apiKey } as TOptions;
}

function hasResolvedCloudflareAuth(options: StreamOptions | undefined): boolean {
	return hasExplicitApiKey(options?.apiKey) || typeof options?.headers?.["cf-aig-authorization"] === "string";
}

function getBuiltinProviderForModel(model: Model<Api>) {
	if (getApiProvider(model.api) !== builtinApiProviderInstances.get(model.api)) return undefined;
	const provider = compatModels.getProvider(model.provider);
	return provider?.getModels().some((candidate) => candidate.api === model.api) ? provider : undefined;
}

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const transcript = normalizeContext(context);
	const builtinProvider = getBuiltinProviderForModel(model);
	if (builtinProvider) {
		if (model.provider.startsWith("cloudflare-") && !hasResolvedCloudflareAuth(options)) {
			return compatModels.stream(model, transcript, options as ModelsApiStreamOptions<TApi> | undefined);
		}
		return builtinProvider.stream(model, transcript, withEnvApiKey(model, options) as ApiStreamOptions<TApi>);
	}
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, transcript, withEnvApiKey(model, options) as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const transcript = normalizeContext(context);
	const builtinProvider = getBuiltinProviderForModel(model);
	if (builtinProvider) {
		if (model.provider.startsWith("cloudflare-") && !hasResolvedCloudflareAuth(options)) {
			return compatModels.streamSimple(model, transcript, options);
		}
		return builtinProvider.streamSimple(model, transcript, withEnvApiKey(model, options));
	}
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, transcript, withEnvApiKey(model, options));
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
