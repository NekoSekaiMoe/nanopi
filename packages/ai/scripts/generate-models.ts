#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { getEffortThinkingLevelMap, type ModelsDevReasoningOption } from "./models-dev-reasoning-options.ts";
import { type AiGatewayPricing, getAiGatewayCost } from "./ai-gateway-pricing.ts";
import { buildOpenRouterCatalog, type OpenRouterCatalog, type OpenRouterModelListItem } from "./openrouter-catalog.ts";
import {
	ALL_PROVIDERS,
	BUILD_CONFIG_FILENAME,
	BUILD_FLAVOR_ENV,
	loadBuildConfig,
	NO_PROVIDERS,
	PROVIDERS_COMPONENT,
	resolveBuildFlavor,
} from "../../../scripts/buildconfig.mjs";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
} from "../src/api/cloudflare.ts";
import type {
	AnthropicMessagesCompat,
	AnyModel,
	Api,
	ClassifierApi,
	ClassifierModel,
	ImageApi,
	ImageModel,
	KnownProvider,
	Model,
	ModelCost,
	ModelPromptCache,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "../src/types.ts";
import {
	assertExactModelIds,
	createModelDataManifest,
	EMPTY_CATALOG_MARKER,
	groupProviderModelData,
	type ModelDataStructure,
	MODEL_DATA_MANIFEST_FILE,
	providerArtifactName,
	readModelDataProviderIds,
	readModelDataStructure,
	validateGeneratedModelData,
	validateModelDataDirectory,
} from "./model-data.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

function readGeneratorOptions(args: string[]): {
	strict: boolean;
	dataOnly: boolean;
	jsonOnly: boolean;
	jsonOutputDir: string | undefined;
	pretty: boolean;
	/** Provider ids the build's provider component carries, or undefined for all. */
	providers: ReadonlySet<string> | undefined;
} {
	let strict = false;
	let dataOnly = false;
	let jsonOnly = false;
	let jsonOutputDir: string | undefined;
	let pretty = false;
	let providers: ReadonlySet<string> | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--strict") {
			strict = true;
			continue;
		}
		if (arg === "--data-only") {
			dataOnly = true;
			continue;
		}
		if (arg === "--json-only") {
			jsonOnly = true;
			continue;
		}
		if (arg === "--pretty") {
			pretty = true;
			continue;
		}
		if (arg === "--json-output") {
			const value = args[++index];
			if (!value) throw new Error("--json-output requires a directory");
			jsonOutputDir = resolve(value);
			continue;
		}
		if (arg === "--providers") {
			const value = args[++index];
			if (!value) throw new Error("--providers requires a comma-separated provider id list");
			providers = new Set(
				value
					.split(",")
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0),
			);
			if (providers.size === 0) throw new Error("--providers requires at least one provider id");
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (jsonOnly && !jsonOutputDir) throw new Error("--json-only requires --json-output");
	if (dataOnly && (jsonOnly || jsonOutputDir)) throw new Error("--data-only cannot be combined with JSON catalog output");
	return { strict, dataOnly, jsonOnly, jsonOutputDir, pretty, providers };
}

const repoRoot = join(packageRoot, "..", "..");
const generatorOptions = readGeneratorOptions(process.argv.slice(2));
generatorOptions.providers = flavorProviderSelection();

/**
 * Providers this run writes: the catalogs, every shard, and the data the shards
 * import. A trimmed build takes the set from buildconfig.json's `providers`
 * component, so it never generates (or commits) catalogs it does not ship, and
 * the generator writes the concrete list back into the config's full provider
 * set, which is the record of what the next `pnpm run generate:models` covers.
 */
function selectProviderIds(providerIds: readonly string[]): string[] {
	const selected = generatorOptions.providers;
	if (selected === undefined) return [...providerIds];
	// A build with no provider ships no catalog: the shards, the aggregator and
	// the data directory all end up empty, and every model comes from models.json.
	if (selected.size === 1 && selected.has(NO_PROVIDERS)) return [];
	const unknown = [...selected].filter((providerId) => !providerIds.includes(providerId));
	if (unknown.length > 0) {
		throw new Error(
			`${BUILD_FLAVOR_ENV}/--providers names providers without a built-in catalog: ${unknown.join(", ")} ` +
				`(known: ${[...providerIds].sort().join(", ")})`,
		);
	}
	return providerIds.filter((providerId) => selected.has(providerId));
}

/**
 * The provider ids the current flavor ships, or undefined to generate all of
 * them. Only a flavor that is asked for explicitly narrows the run: the default
 * flavor keeps the generator's historical behavior of writing every catalog.
 */
function flavorProviderSelection(): ReadonlySet<string> | undefined {
	if (generatorOptions.providers !== undefined) return generatorOptions.providers;
	const hasOverride = process.argv.includes("--flavor") || process.argv.some((arg) => arg.startsWith("--flavor="));
	const envFlavor = process.env[BUILD_FLAVOR_ENV];
	if (!hasOverride && (envFlavor === undefined || envFlavor === "")) return undefined;
	const { flavor, providers } = resolveBuildFlavor(repoRoot);
	if (providers.includes(ALL_PROVIDERS)) return undefined;
	if (providers.includes(NO_PROVIDERS)) {
		console.log(`Flavor ${flavor} ships no provider; generating an empty catalog.`);
		return new Set(providers);
	}
	console.log(`Flavor ${flavor} ships ${providers.length} providers; generating only those catalogs.`);
	return new Set(providers);
}

/**
 * Replaces the full provider set in buildconfig.json with the catalogs this
 * run wrote. Another flavor reading the same config must not name a provider
 * whose catalog no longer exists, and a catalog no set names fails the build
 * (see validateFlavorProviders).
 *
 * Only a run that writes every catalog records anything: an unflavored run
 * does, a trimmed one narrows its own shards on purpose. The set to record
 * carries the `__ALL__` marker, or, once a previous run replaced the marker
 * with concrete ids, is the set the default flavor ships; that flavor is what
 * wrote the catalog. Recording is not optional in the second case: a provider
 * models.dev adds would otherwise leave the config naming a catalog set that
 * no longer exists, and the next build fails in validateFlavorProviders.
 */
function recordFullProviderSet(providerIds: readonly string[]): void {
	const configPath = join(repoRoot, BUILD_CONFIG_FILENAME);
	const config = loadBuildConfig(repoRoot);
	// A trimmed run narrows the catalog on purpose and leaves the full set alone.
	// `flavorProviderSelection` returns a set only for such a run, so the check
	// is the same one the selection made.
	if (generatorOptions.providers !== undefined) return;
	const next = [...providerIds].sort();
	// The marker, if a set still carries one, names the full set. Otherwise the
	// set the default flavor ships does, because that flavor is the one that
	// writes every catalog.
	const markerSet = Object.entries(config.providerSets).find(([, set]) => set.providers.includes(ALL_PROVIDERS));
	const shipped = markerSet?.[0] ?? config.flavors[config.defaultFlavor]?.components[PROVIDERS_COMPONENT];
	if (typeof shipped !== "string") return;
	const set = config.providerSets[shipped];
	if (set === undefined) return;
	const current = [...set.providers].sort();
	if (current.length === next.length && current.every((providerId, index) => providerId === next[index])) return;
	const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
		providerSets: Record<string, { description?: string; providers: string[] }>;
	};
	raw.providerSets[shipped] = { ...set, providers: next };
	writeFileSync(configPath, `${JSON.stringify(raw, null, "\t")}\n`);
	console.log(`Recorded ${next.length} providers in ${BUILD_CONFIG_FILENAME} provider set "${shipped}".`);
}

/**
 * Antigravity is not a models.dev provider. The catalog is the set of models the
 * Cloud Code Assist backend serves to the native client, kept in sync by hand.
 * Subscription access bills nothing per token, so every cost is zero.
 */
function antigravityModels(): Model<"antigravity">[] {
	const cost: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const baseUrl = "https://daily-cloudcode-pa.googleapis.com";
	const entries: { id: string; name: string; contextWindow: number; maxTokens: number }[] = [
		{ id: "gemini-3.1-pro", name: "Gemini 3.1 Pro (Antigravity)", contextWindow: 1048576, maxTokens: 65536 },
		{ id: "gemini-3.1-flash", name: "Gemini 3.1 Flash (Antigravity)", contextWindow: 1048576, maxTokens: 65536 },
		{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Antigravity)", contextWindow: 262144, maxTokens: 64000 },
		{
			id: "claude-opus-4-5-thinking",
			name: "Claude Opus 4.5 Thinking (Antigravity)",
			contextWindow: 262144,
			maxTokens: 64000,
		},
		{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Antigravity)", contextWindow: 131072, maxTokens: 32768 },
	];
	return entries.map((entry) => ({
		...entry,
		api: "antigravity",
		provider: "antigravity",
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost,
	}));
}

interface ModelsDevModel {
	id: string;
	name: string;
	tool_call?: boolean;
	structured_output?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	status?: string;
	limit?: {
		context?: number;
		output?: number;
	};
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		tiers?: {
			input?: number;
			output?: number;
			cache_read?: number;
			cache_write?: number;
			tier?: {
				type?: string;
				size?: number;
			};
		}[];
	};
	modalities?: {
		input?: string[];
		output?: string[];
	};
	provider?: {
		npm?: string;
	};
}

interface ModelsDevProvider {
	name?: string;
	api?: string;
	env?: string[];
	npm?: string;
	models?: Record<string, ModelsDevModel>;
}

interface ModelsDevMetadata {
	id: string;
	type?: string;
	name: string;
	limit?: { context?: number };
	modalities?: { input?: string[] };
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

interface NvidiaNimModelListItem {
	id: string;
}

interface AiGatewayModel {
	id: string;
	name?: string;
	type?: string;
	context_window?: number;
	max_tokens?: number;
	tags?: string[];
	pricing?: AiGatewayPricing;
}

const COPILOT_STATIC_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

const TOGETHER_BASE_URL = "https://api.together.ai/v1";
const TOGETHER_BASE_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
const TOGETHER_TOGGLE_REASONING_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_BASE_COMPAT,
	thinkingFormat: "together",
};
const TOGETHER_REASONING_EFFORT_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_BASE_COMPAT,
	supportsReasoningEffort: true,
	thinkingFormat: "openai",
};
const TOGETHER_TOGGLE_REASONING_EFFORT_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_TOGGLE_REASONING_COMPAT,
	supportsReasoningEffort: true,
};
const TOGETHER_REASONING_ONLY_MODELS = new Set([
	"deepseek-ai/DeepSeek-R1",
	"MiniMaxAI/MiniMax-M2.7",
]);
const TOGETHER_REASONING_EFFORT_MODELS = new Set(["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
const TOGETHER_TOGGLE_REASONING_EFFORT_MODELS = new Set(["deepseek-ai/DeepSeek-V4-Pro-0813"]);
const TOGETHER_FIXED_REASONING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
} as const;
const TOGETHER_REASONING_EFFORT_LEVEL_MAP = {
	off: null,
	minimal: null,
} as const;
const TOGETHER_DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
} as const;
const TOGETHER_TOGGLE_REASONING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
} as const;

const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1";
const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
// TypeSafe-compatible System One endpoint for evaluation models.
// https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe
const AI_GATEWAY_TYPESAFE_BASE_URL = "https://ai-gateway.vercel.sh/typesafe/v1";
const VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const SENSENOVA_BASE_URL = "https://token.sensenova.cn/v1";
const STEPFUN_CN_BASE_URL = "https://api.stepfun.com/v1";
const STEPFUN_GLOBAL_BASE_URL = "https://api.stepfun.ai/v1";
// modal.com's OpenAI-compatible inference gateway. Authentication is a Modal
// proxy token, not a per-vendor API key. https://modal.com/docs/guide/openai-compatibility
const MODAL_BASE_URL = "https://inference.us-west.modal.direct/v1";
// Ollama Cloud token plan: same endpoint as `ollama-cloud`, subscription key.
const OLLAMA_CLOUD_TOKEN_PLAN_BASE_URL = "https://ollama.com/v1";
const PLAIN_OPENAI_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};

// Providers with a hand-written integration (custom protocol, OAuth, regional
// endpoints, extra headers). These keep their dedicated generator branch and
// must not be regenerated by the generic OpenAI-compatible pass.
const EXPLICIT_MODELS_DEV_PROVIDERS = new Set([
	"amazon-bedrock",
	"anthropic",
	"azure",
	"baseten",
	"cerebras",
	"cloudflare-ai-gateway",
	"cloudflare-workers-ai",
	"deepseek",
	"fireworks-ai",
	"github-copilot",
	"google",
	"google-vertex",
	"groq",
	"huggingface",
	"meta",
	"minimax",
	"minimax-cn",
	"mistral",
	"moonshotai",
	"moonshotai-cn",
	"nvidia",
	"openai",
	"opencode",
	"opencode-go",
	"openrouter",
	"sensenova",
	"stepfun",
	"stepfun-ai",
	"together",
	"xai",
	"xiaomi",
	"zhipuai",
]);
// models.dev lists multiple keys over the same endpoint. Keep the first one so the
// catalog does not publish duplicate providers with overlapping model ids.
const DUPLICATE_MODELS_DEV_PROVIDERS = new Set(["zai", "siliconflow-cn", "alibaba-token-plan"]);
// models.dev endpoints that are local servers or need build-time interpolation.
const UNSUPPORTED_MODELS_DEV_PROVIDERS = new Set([
	"atomic-chat",
	"lmstudio",
	"lynkr",
	"privatemode-ai",
	// The dotted id cannot name a TypeScript provider factory or catalog constant.
	"wafer.ai",
]);
const NVIDIA_HEADERS = {
	"NVCF-POLL-SECONDS": "3600",
} as const;
const NVIDIA_OPENAI_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
const NVIDIA_NIM_UNSUPPORTED_MODELS = new Set([
	"abacusai/dracarys-llama-3.1-70b-instruct",
	"bytedance/seed-oss-36b-instruct",
	"deepseek-ai/deepseek-v4-flash",
	"deepseek-ai/deepseek-v4-pro",
	"google/gemma-2-2b-it",
	"google/gemma-3n-e2b-it",
	"google/gemma-3n-e4b-it",
	"google/gemma-4-31b-it",
	"meta/llama-3.2-1b-instruct",
	"meta/llama-4-maverick-17b-128e-instruct",
	"microsoft/phi-4-mini-instruct",
	"minimaxai/minimax-m2.7",
	"mistralai/mistral-nemotron",
	"nvidia/nemotron-mini-4b-instruct",
	"qwen/qwen3-next-80b-a3b-instruct",
	"qwen/qwen3.5-397b-a17b",
	"sarvamai/sarvam-m",
	"upstage/solar-10.7b-instruct",
]);
// Exactly the models.dev providers that ship as built-ins. Adding a vendor here
// means also adding its key to `KnownProvider`, `env-api-keys.ts`, and
// `providers/all.ts`. Everything else — including local servers (Ollama, LM
// Studio, llama.cpp, ...) whose endpoint the user owns — belongs in `models.json`,
// so a built-in catalog never reports an unconfigured vendor as available.
const DIRECT_MODELS_DEV_PROVIDERS = [
	"alibaba-token-plan",
	"alibaba-token-plan-cn",
	"siliconflow",
	"siliconflow-cn",
	"zai",
	"zhipuai",
] as const;
const OLLAMA_CLOUD_TOKEN_PLAN_SOURCE = "ollama-cloud";
const ZAI_TOOL_STREAM_UNSUPPORTED_MODELS = new Set(["glm-4.5", "glm-4.5-air", "glm-4.5-flash", "glm-4.5v"]);
const OPENCODE_GO_GLM52_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;
const EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS = new Set([
	"github-copilot:claude-haiku-4.5",
	"github-copilot:claude-sonnet-4",
	"github-copilot:claude-sonnet-4.5",
]);
const ANTHROPIC_ALLOWED_FALLBACK_MODELS = {
	"claude-fable-5": ["claude-opus-4-8", "claude-opus-5"],
	"claude-opus-5": ["claude-opus-4-8"],
} satisfies Record<string, string[]>;

const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;
const DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP = {
	...DEEPSEEK_V4_THINKING_LEVEL_MAP,
	low: "low",
} as const;
// Azure Foundry rejects DeepSeek's own max effort.
const AZURE_DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
} as const;
// Verified against Fireworks Messages raw_output on 2026-09-10 (#9323).
// Fall back to verified support when models.dev omits effort metadata; this is
// not an allowlist. Any Fireworks Messages model advertising effort uses adaptive thinking.
const FIREWORKS_ADAPTIVE_THINKING_FALLBACK_MODELS = new Set([
	"accounts/fireworks/models/deepseek-v4-flash-0731",
	"accounts/fireworks/models/deepseek-v4-flash-vision-exp",
	"accounts/fireworks/models/deepseek-v4-pro-0813",
	"accounts/fireworks/models/qwen3p8-max",
	"accounts/fireworks/models/qwen3p8-2p4t-a95b",
]);
const QWEN_TOKEN_PLAN_FALLBACK_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;
const QWEN_TOKEN_PLAN_REASONING_EFFORT_FALLBACK_MODEL_IDS = new Set(["glm-5", "glm-5.1"]);
// Retired preview id — models.dev may still list it after GA ships.
const QWEN_TOKEN_PLAN_EXCLUDED_MODEL_IDS = new Set(["qwen3.8-max-preview"]);
const QWEN_TOKEN_PLAN_PROVIDER_IDS = new Set<string>([
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
]);
// QwenCloud Token Plan Individual text-model allowlist, verified 2026-09-03.
// Retired models remain excluded above even if the public catalog lags.
// https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview
const QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS = new Set<string>([
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"deepseek-v4-pro-0813",
	"glm-5.2",
	"qwen3.6-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-flash",
	"qwen3.8-max",
]);

const KIMI_K3_MAX_TOKENS = 131072;
const KIMI_K3_COST = {
	input: 3,
	output: 15,
	cacheRead: 0.3,
	cacheWrite: 0,
} as const;
// Kimi Coding is subscription-backed, so models.dev reports zero cost. Use the
// equivalent Moonshot API rates to estimate the value of subscription usage.
const KIMI_CODING_IMPLIED_COSTS: Record<string, Model<Api>["cost"]> = {
	k3: KIMI_K3_COST,
	"kimi-for-coding": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	"kimi-for-coding-highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
	"kimi-k2-thinking": { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
};
const OPENROUTER_KIMI_K3_MODEL_IDS = new Set(["moonshotai/kimi-k3", "~moonshotai/kimi-latest"]);

const BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS = new Set(["anthropic.claude-opus-5"]);
// Bedrock Mantle/OpenAI Responses routing is based on AWS's model-card endpoint/API support metadata.
// Sources checked:
// - https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards.html
// - https://docs.aws.amazon.com/bedrock/latest/userguide/models-api-compatibility.html
const BEDROCK_MANTLE_OPENAI_RESPONSES_MODEL_IDS = new Set([
	"google.gemma-4-31b",
	"google.gemma-4-26b-a4b",
	"google.gemma-4-e2b",
	"openai.gpt-5.6-sol",
	"openai.gpt-5.6-terra",
	"openai.gpt-5.6-luna",
	"openai.gpt-5.6-cyber",
	"openai.gpt-daybreak-blue-5.6-sol",
	"openai.gpt-5.5",
	"openai.gpt-5.4",
	"openai.gpt-oss-120b",
	"openai.gpt-oss-20b",
	"xai.grok-4.3",
	"xai.grok-4.6",
]);
const BEDROCK_MANTLE_OPENAI_RESPONSES_V1_MODEL_IDS = new Set(["openai.gpt-oss-120b", "openai.gpt-oss-20b"]);
const BEDROCK_MANTLE_ANTHROPIC_MESSAGES_MODEL_IDS = new Set([
	"anthropic.claude-opus-5",
	"anthropic.claude-sonnet-5",
	"anthropic.claude-mythos-5",
	"anthropic.claude-fable-5",
	"anthropic.claude-opus-4-8",
	"anthropic.claude-opus-4-7",
	"anthropic.claude-haiku-4-5",
	"anthropic.claude-mythos-preview",
]);
const BEDROCK_MANTLE_ANTHROPIC_MESSAGES_ROOT_MODEL_IDS = new Set(["anthropic.claude-mythos-preview"]);
const MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS = new Set(["gpt-5.6"]);
const OPENAI_TOOL_SEARCH_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
]);
const OPENAI_ADDITIONAL_TOOLS_MODEL_IDS = OPENAI_TOOL_SEARCH_MODEL_IDS;
const OPENAI_MID_CONVO_SYSTEM_MESSAGE_MODEL_IDS = OPENAI_TOOL_SEARCH_MODEL_IDS;
const OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
]);
const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD = 272000;
const OPENAI_SHORT_CONTEXT_CAPPED_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
]);
const OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-6.1-sol",
]);

// Keep the generated default no less restrictive than coding-agent's historical
// image preprocessing. Provider limits can narrow this profile, but unknown
// providers retain the cache-safe 2000px / 4.5 MiB behavior.
const DEFAULT_IMAGE_RESIZE = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: 4.5 * 1024 * 1024,
	jpegQuality: 80,
} as const;

function withOpenAiLongContextPricing(cost: Model<Api>["cost"]): Model<Api>["cost"] {
	return {
		...cost,
		tiers: [
			{
				inputTokensAbove: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
				input: roundCost(cost.input * 2),
				output: roundCost(cost.output * 1.5),
				cacheRead: roundCost(cost.cacheRead * 2),
				cacheWrite: roundCost(cost.cacheWrite * 2),
			},
		],
	};
}

// Keep current OpenAI prices authoritative until models.dev and passthrough
// catalogs catch up.
// https://developers.openai.com/api/docs/pricing
const OPENAI_STANDARD_COSTS: Record<string, ModelCost> = {
	"gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	"gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
	"gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
	"gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	"gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
	"gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};

const OPENAI_RESPONSES_NONE_REASONING_MODELS = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-sol",
	"gpt-6-luna",
]);
const XAI_BUILTIN_EXCLUDED_MODEL_IDS = new Set([
	"grok-3",
	"grok-3-fast",
	"grok-4.20-0309-non-reasoning",
	"grok-4.20-0309-reasoning",
	"grok-build-0.1",
	"grok-code-fast-1",
]);
const XAI_RESPONSES_COMPAT: OpenAIResponsesCompat = {
	supportsLongCacheRetention: false,
};

const OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS = new Set([
	"opencode:deepseek-v4-flash",
	"opencode:deepseek-v4-pro",
	"opencode:kimi-k2.5",
	"opencode:kimi-k2.6",
	"opencode:minimax-m2.7",
	"opencode-go:kimi-k2.6",
]);

// GitHub's "Models with extended capabilities" table lists these Copilot models as supporting
// the extended 1 million token context window.
const GITHUB_COPILOT_EXTENDED_CONTEXT_MODELS = new Set([
	"claude-fable-5",
	"claude-opus-4.6",
	"claude-opus-4.7",
	"claude-opus-4.8",
	"claude-opus-5",
	"claude-opus-5.5",
	"claude-sonnet-4.6",
	"claude-sonnet-5",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.5",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6-sol",
]);

// Checked manually against the authenticated GitHub Copilot /models endpoint on 2026-06-15.
// Keep this to narrow corrections over models.dev metadata instead of snapshotting Copilot's catalog.
const GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES = {
	"claude-opus-4.7": { minimal: "low" },
	"claude-opus-4.8": { minimal: "low" },
	"claude-opus-5": { minimal: "low" },
	"claude-sonnet-4.6": { minimal: "low", max: "max" },
} satisfies Record<string, NonNullable<Model<Api>["thinkingLevelMap"]>>;

function mergeThinkingLevelMap(model: Model<any>, map: NonNullable<Model<any>["thinkingLevelMap"]>): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

const modelsDevReasoningOptions = new Map<string, ModelsDevReasoningOption[]>();

function getModelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}:${model.id}`;
}

function recordModelsDevReasoningOptions(provider: string, id: string, sourceModel: ModelsDevModel): void {
	if (sourceModel.reasoning_options !== undefined) {
		modelsDevReasoningOptions.set(`${provider}:${id}`, sourceModel.reasoning_options);
	}
}

function supportsDirectReasoningEffort(model: Model<Api>): boolean {
	if (model.api === "anthropic-messages") return model.compat?.forceAdaptiveThinking === true;
	if (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses"
	) {
		return true;
	}
	if (model.api !== "openai-completions") return false;

	const compat = {
		...detectOpenAICompletionsCompat(model as Model<"openai-completions">),
		...(model.compat as OpenAICompletionsCompat | undefined),
	};
	return compat.thinkingFormat === "openai" && compat.supportsReasoningEffort;
}

function applyModelsDevReasoningOptionMetadata(model: Model<Api>): void {
	const reasoningOptions = modelsDevReasoningOptions.get(getModelKey(model));
	if (!reasoningOptions || !supportsDirectReasoningEffort(model)) return;
	const thinkingLevelMap = getEffortThinkingLevelMap(reasoningOptions);
	if (thinkingLevelMap) mergeThinkingLevelMap(model, thinkingLevelMap);
}

function getTogetherCompat(modelId: string, reasoning: boolean): OpenAICompletionsCompat {
	if (!reasoning) return TOGETHER_BASE_COMPAT;
	if (TOGETHER_REASONING_EFFORT_MODELS.has(modelId)) return TOGETHER_REASONING_EFFORT_COMPAT;
	if (TOGETHER_TOGGLE_REASONING_EFFORT_MODELS.has(modelId)) return TOGETHER_TOGGLE_REASONING_EFFORT_COMPAT;
	if (TOGETHER_REASONING_ONLY_MODELS.has(modelId)) return TOGETHER_BASE_COMPAT;
	return TOGETHER_TOGGLE_REASONING_COMPAT;
}

function getTogetherThinkingLevelMap(
	modelId: string,
	reasoning: boolean,
): NonNullable<Model<any>["thinkingLevelMap"]> | undefined {
	if (!reasoning) return undefined;
	if (TOGETHER_REASONING_EFFORT_MODELS.has(modelId)) return { ...TOGETHER_REASONING_EFFORT_LEVEL_MAP };
	if (TOGETHER_TOGGLE_REASONING_EFFORT_MODELS.has(modelId)) return { ...TOGETHER_DEEPSEEK_V4_THINKING_LEVEL_MAP };
	if (TOGETHER_REASONING_ONLY_MODELS.has(modelId)) return { ...TOGETHER_FIXED_REASONING_LEVEL_MAP };
	return { ...TOGETHER_TOGGLE_REASONING_LEVEL_MAP };
}

function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5") ||
		modelId.includes("gpt-5.6") ||
		modelId.includes("gpt-6")
	);
}

function supportsOpenAiMax(model: Model<Api>): boolean {
	return (
		(model.id.includes("gpt-5.6") || model.id.includes("gpt-6")) &&
		(model.api === "openai-responses" ||
			model.api === "azure-openai-responses" ||
			model.api === "openai-codex-responses" ||
			model.api === "openai-completions")
	);
}

const VERIFIED_ANTHROPIC_MID_CONVO_EFFORT_PROVIDERS = new Set(["anthropic", "openrouter"]);
// OpenRouter rejects `configuration_update` system messages on Opus 5 ("Mid-conversation
// reasoning effort (configuration_update) is not supported on anthropic/claude-opus-5-20260723")
// while accepting them on Fable 5.1, so gate that model there.
const MID_CONVO_EFFORT_UNSUPPORTED_ANTHROPIC_MODELS = new Set(["openrouter:anthropic/claude-opus-5"]);

function supportsAnthropicMidConvoEffort(modelId: string): boolean {
	const id = modelId.toLowerCase().replace(/^~?anthropic\//, "");
	return (
		/^claude-opus-(?:5|5[.-]5)(?:-\d{8})?$/.test(id) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(id) ||
		/^claude-(?:fable|mythos)-5(?:[.-]1)(?:-\d{8})?$/.test(id)
	);
}

function supportsAnthropicMidConvoSystemMessages(modelId: string): boolean {
	return (
		/^claude-opus-(?:4[.-]8|5(?:[.-]5)?)(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:fable|mythos)-5(?:[.-]1)?(?:-\d{8})?$/.test(modelId)
	);
}

function isAnthropicAdaptiveThinkingModel(modelId: string): boolean {
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("opus-4-7") ||
		modelId.includes("opus-4.7") ||
		modelId.includes("opus-4-8") ||
		modelId.includes("opus-4.8") ||
		modelId.includes("opus-5") ||
		modelId.includes("opus.5") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6") ||
		modelId.includes("sonnet-5") ||
		modelId.includes("sonnet.5") ||
		modelId.includes("haiku-5") ||
		modelId.includes("haiku.5") ||
		modelId.includes("fable-5") ||
		modelId.includes("mythos-5")
	);
}

function isAnthropicTemperatureUnsupportedModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return (
		id.includes("opus-4-7") ||
		id.includes("opus-4.7") ||
		id.includes("opus-4-8") ||
		id.includes("opus-4.8") ||
		id.includes("opus-5") ||
		id.includes("opus.5") ||
		id.includes("sonnet-5-5") ||
		id.includes("sonnet-5.5") ||
		id.includes("haiku-5-5") ||
		id.includes("haiku-5.5")
	);
}

const OPENAI_COMPLETIONS_DEFAULT_COMPAT = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsStrictMode: false,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
} satisfies Required<
	Omit<
		OpenAICompletionsCompat,
		"cacheControlFormat" | "supportsThinkingTokenBudget" | "thinkingTokenBudgetField"
	>
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

type OpenAICompletionsResolvedCompat = typeof OPENAI_COMPLETIONS_DEFAULT_COMPAT & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

function mergeAnthropicMessagesCompat(model: Model<Api>, compat: AnthropicMessagesCompat): void {
	model.compat = { ...(model.compat as AnthropicMessagesCompat | undefined), ...compat };
}

function detectOpenAICompletionsCompat(model: Model<"openai-completions">): OpenAICompletionsResolvedCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;

	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	const isTogether =
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
	const isTogetherReasoningOnly = isTogether && TOGETHER_REASONING_ONLY_MODELS.has(model.id);
	const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");

	const isNonStandard =
		isNvidia ||
		isCerebras ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway;

	const useMaxTokens =
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isMoonshot ||
		isCloudflareAiGateway ||
		isTogether ||
		isNvidia ||
		isZai;

	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	const cacheControlFormat =
		provider === "openrouter" && /^~?anthropic\//.test(model.id) ? "anthropic" : undefined;

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
		supportsReasoningEffort:
			!isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat: isDeepSeek
			? "deepseek"
			: isZai
				? "zai"
				: isTogether && !isTogetherReasoningOnly
					? "together"
					: isOpenRouter
						? "openrouter"
						: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		// Preserve built-in behavior as explicit metadata against the conservative runtime default.
		supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isCerebras,
		supportsOpenAIGrammarTools: false,
		supportsMidConvoSystemMessages: false,
		supportsMidConvoToolAdditions: false,
		...(cacheControlFormat ? { cacheControlFormat } : {}),
		sendSessionAffinityHeaders: isOpenRouter,
		supportsLongCacheRetention: !(isTogether || isCloudflareWorkersAI || isCloudflareAiGateway || isNvidia),
	};
}

function isPlainEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function openAICompletionsCompatDelta(compat: OpenAICompletionsResolvedCompat): OpenAICompletionsCompat {
	const delta: OpenAICompletionsCompat = {};
	for (const [key, value] of Object.entries(compat)) {
		const defaultValue = OPENAI_COMPLETIONS_DEFAULT_COMPAT[key as keyof typeof OPENAI_COMPLETIONS_DEFAULT_COMPAT];
		if (isPlainEmptyObject(value) && isPlainEmptyObject(defaultValue)) continue;
		if (value !== defaultValue) {
			(delta as Record<string, unknown>)[key] = value;
		}
	}
	return delta;
}

function mergeOpenAICompletionsCompat(model: Model<Api>, compat: OpenAICompletionsCompat): void {
	model.compat = { ...(model.compat as OpenAICompletionsCompat | undefined), ...compat };
}

function applyOpenAICompletionsCompatMetadata(model: Model<Api>): void {
	if (model.api !== "openai-completions") return;
	const detected = openAICompletionsCompatDelta(detectOpenAICompletionsCompat(model as Model<"openai-completions">));
	model.compat = { ...detected, ...(model.compat as OpenAICompletionsCompat | undefined) };
	if (Object.keys(model.compat).length === 0) {
		delete model.compat;
	}
}

function applyAnthropicMessagesCompatMetadata(model: Model<Api>): void {
	if (model.api !== "anthropic-messages") return;
	const compat = getAnthropicMessagesCompat(model.provider, model.id);
	if (compat) {
		mergeAnthropicMessagesCompat(model, compat);
		if (compat.supportsMidConvoEffort) mergeThinkingLevelMap(model, { off: null });
	}
}

function isAnthropicFallbackMetadataModel(model: Model<Api>): model is Model<"anthropic-messages"> {
	if (model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
	return (
		model.id in ANTHROPIC_ALLOWED_FALLBACK_MODELS ||
		Object.values(ANTHROPIC_ALLOWED_FALLBACK_MODELS).some((fallbackModelIds) => fallbackModelIds.includes(model.id))
	);
}

function applyAnthropicAllowedFallbackModelMetadata(models: readonly Model<"anthropic-messages">[]): void {
	const modelsById = new Map(models.map((model) => [model.id, model]));
	for (const [modelId, fallbackModelIds] of Object.entries(ANTHROPIC_ALLOWED_FALLBACK_MODELS)) {
		const model = modelsById.get(modelId);
		if (!model) continue;

		const compatibleFallbackModelIds = model.compat?.supportsMidConvoEffort
			? fallbackModelIds.filter(supportsAnthropicMidConvoEffort)
			: fallbackModelIds;
		const allowedFallbackModels = compatibleFallbackModelIds.flatMap((fallbackModelId) => {
			const fallbackModel = modelsById.get(fallbackModelId);
			return fallbackModel
				? [{ provider: fallbackModel.provider, model: fallbackModel.id, cost: fallbackModel.cost }]
				: [];
		});
		if (allowedFallbackModels.length > 0) {
			mergeAnthropicMessagesCompat(model, { allowedFallbackModels });
		}
	}
}

function applyStrictToolCompatMetadata(model: Model<Api>): void {
	if (
		(model.provider === "openai" || model.provider === "cloudflare-ai-gateway") &&
		model.api === "openai-responses"
	) {
		model.compat = { ...(model.compat as OpenAIResponsesCompat | undefined), supportsStrictMode: true };
	} else if (model.provider === "anthropic" && model.api === "anthropic-messages") {
		mergeAnthropicMessagesCompat(model, { supportsStrictTools: true });
	}
}

// Responses endpoints verified (OpenAI, ChatGPT Codex backend, GitHub Copilot,
// opencode zen) or documented (Azure OpenAI, Cloudflare AI Gateway) to pass
// OpenAI custom grammar tools through. OpenAI rejects `type: "custom"` tools
// for pre-GPT-5 models (gpt-4.x, gpt-4o, o-series).
const OPENAI_GRAMMAR_TOOL_PROVIDERS = new Set([
	"openai",
	"openai-codex",
	"azure",
	"github-copilot",
	"opencode",
	"cloudflare-ai-gateway",
]);
const OPENAI_GRAMMAR_TOOL_APIS = new Set<Api>([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);

function applyOpenAIGrammarToolCompatMetadata(model: Model<Api>): void {
	if (!OPENAI_GRAMMAR_TOOL_APIS.has(model.api) || !OPENAI_GRAMMAR_TOOL_PROVIDERS.has(model.provider)) return;
	const match = /^gpt-(\d+)/.exec(model.id);
	if (!match || Number(match[1]) < 5) return;
	model.compat = { ...(model.compat as OpenAIResponsesCompat | undefined), supportsOpenAIGrammarTools: true };
}

function applyOpenAIToolSearchMetadata(model: Model<Api>): void {
	const isOpenAIResponses = model.provider === "openai" && model.api === "openai-responses";
	const isOpenAICodex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
	if (!(isOpenAIResponses || isOpenAICodex) || !OPENAI_TOOL_SEARCH_MODEL_IDS.has(model.id)) return;
	const supportsAdditionalTools =
		(isOpenAIResponses && OPENAI_ADDITIONAL_TOOLS_MODEL_IDS.has(model.id)) ||
		(isOpenAICodex && OPENAI_CODEX_ADDITIONAL_TOOLS_MODEL_IDS.has(model.id));
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		...(supportsAdditionalTools ? { supportsAdditionalTools: true } : {}),
		supportsToolSearch: true,
	};
}

// Moonshot Kimi K2.6/K2.7 accept system text after the conversation starts but reject
// tool-bearing system messages. Kimi K3 accepts both forms; Fireworks and OpenCode pass
// its tool-bearing form through. GitHub Copilot forwards K3 text but silently drops its
// tool-bearing message. DeepSeek V4 Pro and OpenAI models behind OpenRouter also accept
// plain system text in place.
function applyOpenAICompletionsTranscriptMetadata(model: Model<Api>): void {
	if (model.api !== "openai-completions") return;
	const isKimiK3 =
		(model.provider.startsWith("moonshot") && model.id === "kimi-k3") ||
		(model.provider === "fireworks" && model.id.includes("kimi-k3")) ||
		((model.provider === "opencode" || model.provider === "opencode-go") && model.id === "kimi-k3");
	const isMoonshotKimiK2 =
		model.provider.startsWith("moonshot") &&
		(model.id === "kimi-k2.6" || model.id === "kimi-k2.7-code" || model.id === "kimi-k2.7-code-highspeed");
	const isTextOnly =
		isMoonshotKimiK2 ||
		(model.provider === "github-copilot" && model.id === "kimi-k3") ||
		(model.provider === "deepseek" && model.id === "deepseek-v4-pro") ||
		(model.provider === "openrouter" &&
			model.id.startsWith("openai/") &&
			OPENAI_MID_CONVO_SYSTEM_MESSAGE_MODEL_IDS.has(model.id.slice("openai/".length)));
	if (!isKimiK3 && !isTextOnly) return;
	model.compat = {
		...(model.compat as OpenAICompletionsCompat | undefined),
		supportsMidConvoSystemMessages: true,
		...(isKimiK3 ? { supportsMidConvoToolAdditions: true } : {}),
	};
}

// Newer OpenAI Responses models accept developer messages after the conversation has started.
// OpenCode Zen, OpenCode Go, and GitHub Copilot pass both those messages and
// `additional_tools` items through to OpenAI unchanged; tool search is not verified
// through those proxies.
const OPENAI_RESPONSES_PROXY_PROVIDERS = new Set(["opencode", "opencode-go", "github-copilot"]);

function applyOpenAIResponsesTranscriptMetadata(model: Model<Api>): void {
	const isOpenAIResponses = model.provider === "openai" && model.api === "openai-responses";
	const isOpenAICodex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
	const isProxiedResponses =
		OPENAI_RESPONSES_PROXY_PROVIDERS.has(model.provider) && model.api === "openai-responses";
	if (
		!(isOpenAIResponses || isOpenAICodex || isProxiedResponses) ||
		!OPENAI_MID_CONVO_SYSTEM_MESSAGE_MODEL_IDS.has(model.id)
	) {
		return;
	}
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		supportsMidConvoSystemMessages: true,
		...(isProxiedResponses ? { supportsAdditionalTools: true } : {}),
	};
}

// OpenAI charges prompt-cache writes starting with the GPT-5.6 family, and exactly
// those models accept `prompt_cache_options`; older models reject the parameter.
// https://developers.openai.com/api/docs/guides/prompt-caching
function applyOpenAIExplicitPromptCacheMetadata(model: Model<Api>): void {
	if (model.provider !== "openai" || model.api !== "openai-responses") return;
	if (!(model.cost.cacheWrite > 0)) return;
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		supportsExplicitPromptCacheMode: true,
	};
}

// Models whose prompt cache survives in-context compaction in real nanopi sessions: after a tool-heavy
// turn with native reasoning, the compaction request (same conversation plus a system message and
// a user message, `toolChoice: "none"`) reads at least 90% of the last turn's prompt from cache.
// Validated 2026-10-06 by driving nanopi in RPC mode and compacting directly after the tool turn.
// test/in-context-compaction-probe.ts alone is not enough: its synthetic history has no native
// reasoning, so it passes models that fail in real sessions.
// Failures stay unflagged. openai-codex/gpt-5.5, moonshotai/kimi-k2.6, and GPT-5.4 and GPT-5.4 mini
// on opencode and openrouter read 0-9%: the appended user message makes the provider drop the
// last turn's reasoning from the rendered prompt, so the cache breaks at the start of that turn.
// deepseek/deepseek-v4-pro read 0% and opencode-go/kimi-k3 read 89% in the probe.
// opencode/claude-opus-4-8 and opencode-go/gpt-5.6-luna were unreachable (model access disabled);
// they stay flagged because the same models pass through other providers.
const IN_CONTEXT_COMPACTION_VERIFIED_MODELS = new Set([
	"anthropic/claude-fable-5",
	"anthropic/claude-fable-5-1",
	"anthropic/claude-opus-4-8",
	"anthropic/claude-opus-5-5",
	"anthropic/claude-sonnet-5-5",
	"moonshotai/kimi-k2.7-code",
	"moonshotai/kimi-k2.7-code-highspeed",
	"moonshotai/kimi-k3",
	"openai-codex/gpt-5.6-luna",
	"openai-codex/gpt-5.6-sol",
	"openai-codex/gpt-5.6-terra",
	"openai-codex/gpt-6-astra",
	"openai-codex/gpt-6-luna",
	"openai-codex/gpt-6-sol",
	"openai-codex/gpt-6.1-sol",
	"opencode-go/gpt-5.6-luna",
	"opencode-go/gpt-6-luna",
	"opencode/claude-fable-5-1",
	"opencode/claude-opus-4-8",
	"opencode/claude-opus-5-5",
	"opencode/claude-sonnet-5-5",
	"opencode/kimi-k3",
	"openrouter/openai/gpt-5.5",
	"openrouter/openai/gpt-5.6-luna",
	"openrouter/openai/gpt-5.6-sol",
	"openrouter/openai/gpt-5.6-terra",
	"openrouter/openai/gpt-6-astra",
	"openrouter/openai/gpt-6-luna",
	"openrouter/openai/gpt-6-sol",
	"openrouter/openai/gpt-6.1-sol",
]);

function applyInContextCompactionMetadata(model: Model<Api>): void {
	if (!IN_CONTEXT_COMPACTION_VERIFIED_MODELS.has(`${model.provider}/${model.id}`)) return;
	const compat = model.compat as (AnthropicMessagesCompat & OpenAIResponsesCompat & OpenAICompletionsCompat) | undefined;
	// In-context compaction sends the instructions as a mid-conversation system message.
	if (compat?.supportsMidConvoSystemMessages !== true) return;
	model.compat = { ...compat, supportsInContextCompaction: true };
}

// Anthropic ephemeral entries have a hard five-minute lifetime; `ttl: "1h"`
// extends it to one hour. Only direct Anthropic is annotated so cache warming
// does not assume equivalent behavior through proxies.
// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
const ANTHROPIC_PROMPT_CACHE: ModelPromptCache = { short: 300, long: 3600 };

function applyPromptCacheMetadata(model: Model<Api>): void {
	if (model.provider === "anthropic" && model.api === "anthropic-messages") {
		model.promptCache = ANTHROPIC_PROMPT_CACHE;
	}
	// Do not add OpenAI lifetimes yet. Before enabling warming for explicit
	// OpenAI caches, re-evaluate it using observed expiry, replay, and billing
	// behavior; a documented TTL alone does not establish full cache loss.
}

function applyImageInputMetadata(model: AnyModel): void {
	if (!model.input.includes("image")) return;

	const providerLimits: AnyModel["inputLimits"] =
		model.provider === "anthropic"
			? {
					maxRequestBytes: 32 * 1024 * 1024,
					images: { maxPerRequest: model.type !== "image" && model.contextWindow === 200000 ? 100 : 600 },
				}
			: model.provider === "amazon-bedrock"
				? { images: { maxPerMessage: 20 } }
				: model.provider === "openai"
					? { maxRequestBytes: 512 * 1024 * 1024, images: { maxPerRequest: 1500 } }
					: model.provider === "google"
						? { maxRequestBytes: 20 * 1024 * 1024, images: { maxPerRequest: 3600 } }
						: undefined;
	const configuredImages = model.inputLimits?.images;
	model.inputLimits = {
		...providerLimits,
		...model.inputLimits,
		images: {
			...providerLimits?.images,
			...configuredImages,
			resize: { ...DEFAULT_IMAGE_RESIZE, ...configuredImages?.resize },
		},
	};
}

function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

function getGoogleThinkingLevelMap(
	modelId: string,
	reasoningOptions: readonly ModelsDevReasoningOption[],
): NonNullable<Model<Api>["thinkingLevelMap"]> | undefined {
	const effortMap = getEffortThinkingLevelMap(reasoningOptions);
	if (effortMap) return effortMap;
	if (isGemma4Model(modelId)) {
		return { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" };
	}
	return undefined;
}

function applyThinkingLevelMetadata(model: Model<any>): void {
	if (
		(model.api === "openai-responses" || model.api === "azure-openai-responses") &&
		model.id.startsWith("gpt-5")
	) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (
		(model.id === "gpt-6-astra" ||
			model.id === "gpt-6-sol" ||
			model.id === "gpt-6-luna" ||
			model.id === "gpt-6.1-sol") &&
		(model.api === "openai-responses" ||
			model.api === "azure-openai-responses" ||
			model.api === "openai-codex-responses")
	) {
		mergeThinkingLevelMap(model, {
			// GPT-6 Astra and GPT-6.1 Sol reject reasoning.effort "none".
			off: model.id === "gpt-6-astra" || model.id === "gpt-6.1-sol" ? null : "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	}
	if (model.provider === "github-copilot" && model.id.startsWith("gpt-5")) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		model.api === "openai-responses" &&
		model.provider === "openai" &&
		OPENAI_RESPONSES_NONE_REASONING_MODELS.has(model.id)
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
	// xAI models without verified effort options must not send the undocumented
	// "none"/"minimal" efforts.
	if (model.provider === "xai" && model.api === "openai-responses" && model.thinkingLevelMap === undefined) {
		mergeThinkingLevelMap(model, { off: null, minimal: null });
	}
	if (supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (supportsOpenAiMax(model)) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (model.provider === "openai" && model.id === "gpt-5.5") {
		mergeThinkingLevelMap(model, { minimal: null });
	}
	if (model.id.endsWith("gpt-5.5-pro")) {
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null });
	}
	// Anthropic adaptive-thinking effort support (per Anthropic adaptive thinking docs):
	// - "max" is available on all adaptive-thinking Claude models.
	// - "xhigh" is only available on Opus 4.7/4.8/5, Sonnet 5, Haiku 5.5, and Fable 5.
	if (
		model.id.includes("opus-4-6") ||
		model.id.includes("opus-4.6") ||
		model.id.includes("sonnet-4-6") ||
		model.id.includes("sonnet-4.6")
	) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7") ||
		model.id.includes("opus-4-8") ||
		model.id.includes("opus-4.8") ||
		model.id.includes("opus-5") ||
		model.id.includes("opus.5") ||
		model.id.includes("sonnet-5") ||
		model.id.includes("sonnet.5") ||
		model.id.includes("haiku-5") ||
		model.id.includes("haiku.5")
	) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh", max: "max" });
	}
	if (model.id.includes("fable-5")) {
		mergeThinkingLevelMap(model, { off: null, xhigh: "xhigh", max: "max" });
	}
	if (model.api === "anthropic-messages" && isAnthropicAdaptiveThinkingModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { forceAdaptiveThinking: true });
	}
	if (model.api === "anthropic-messages" && isAnthropicTemperatureUnsupportedModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { supportsTemperature: false });
	}
	if (
		model.api === "openai-completions" &&
		model.id.includes("deepseek-v4") &&
		model.thinkingLevelMap === undefined
	) {
		mergeThinkingLevelMap(
			model,
			model.provider === "openrouter"
				? { ...DEEPSEEK_V4_THINKING_LEVEL_MAP, xhigh: "xhigh", max: null }
				: model.provider === "azure"
					? AZURE_DEEPSEEK_V4_THINKING_LEVEL_MAP
					: (model.provider === "deepseek" || model.provider === "opencode" || model.provider === "opencode-go") &&
						model.id.includes("deepseek-v4-flash")
						? DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP
						: DEEPSEEK_V4_THINKING_LEVEL_MAP,
		);
	}
	if (model.provider === "groq" && model.id === "qwen/qwen3.6-27b") {
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null, high: "default" });
	}
	if (model.provider === "openai-codex" && supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		(model.provider === "moonshotai" || model.provider === "moonshotai-cn") &&
		(model.id === "kimi-k2.7-code" || model.id === "kimi-k2.7-code-highspeed")
	) {
		// Kimi K2.7 Code is always-thinking. Official docs say
		// `thinking: { type: "disabled" }` is rejected, and callers can omit
		// the thinking parameter to use the enabled default.
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "openrouter" && model.id.startsWith("inception/mercury-2")) {
		// Mercury 2 in instant mode (reasoning_effort: "none") disables tool calling.
		// Mark "off" unsupported so the openai-completions provider omits the reasoning param
		// instead of defaulting to {reasoning:{effort:"none"}} (see openai-completions.ts:575).
		// nanopi's low/medium/high pass through verbatim; OpenRouter normalizes to Mercury's vocabulary.
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "openrouter" && model.id === "z-ai/glm-5.2") {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (model.provider === "fireworks") {
		if (model.api === "anthropic-messages" && model.compat?.forceAdaptiveThinking) {
			// Qwen Max currently advertises only a toggle. Prefer upstream effort
			// metadata once available instead of replacing it with this fallback.
			if (model.id === "accounts/fireworks/models/qwen3p8-max" && !model.thinkingLevelMap) {
				model.thinkingLevelMap = getEffortThinkingLevelMap([
					{ type: "effort", values: ["low", "medium", "xhigh"] },
				]);
			}
			const reasoningOptions = modelsDevReasoningOptions.get(getModelKey(model));
			if (
				reasoningOptions?.some((option) => option.type === "toggle") ||
				// The 2.4T alias omits the verified toggle in models.dev.
				model.id === "accounts/fireworks/models/qwen3p8-2p4t-a95b"
			) {
				mergeThinkingLevelMap(model, { off: "none" });
			}
			if (model.id === "accounts/fireworks/models/deepseek-v4-pro-0813") {
				mergeThinkingLevelMap(model, { low: "low" });
			}
		}
		if (model.id.includes("glm-5p2")) {
			// GLM 5.2 and its fast router support off/high/max. Fireworks maps low
			// and medium to high, so do not expose those aliases as distinct levels.
			mergeThinkingLevelMap(model, { off: "none", minimal: null, low: null, medium: null, max: "max" });
		}
		if (model.id.includes("kimi-k3")) {
			// Fireworks maps medium to high on both APIs; do not expose it as a distinct level.
			mergeThinkingLevelMap(model, { medium: null });
		}
	}
	if (model.provider === "opencode-go" && model.id === "glm-5.2") {
		mergeThinkingLevelMap(model, OPENCODE_GO_GLM52_THINKING_LEVEL_MAP);
	}
	if (model.provider === "opencode-go" && model.id === "kimi-k2.6") {
		// OpenCode Go exposes Kimi K2.6 thinking as on/off, not distinct effort tiers.
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null });
	}
	if (model.provider === "opencode" && model.id === "grok-build-0.1") {
		// OpenCode Zen Grok Build reasons by default but rejects explicit reasoningEffort.
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null, medium: null });
	}
	if (model.provider === "github-copilot") {
		const override = GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES[model.id];
		if (override) {
			mergeThinkingLevelMap(model, override);
		}
	}
}

function getAnthropicMessagesCompat(provider: string, modelId: string): AnthropicMessagesCompat | undefined {
	const compat: AnthropicMessagesCompat = {};
	if (
		VERIFIED_ANTHROPIC_MID_CONVO_EFFORT_PROVIDERS.has(provider) &&
		supportsAnthropicMidConvoEffort(modelId) &&
		!MID_CONVO_EFFORT_UNSUPPORTED_ANTHROPIC_MODELS.has(`${provider}:${modelId}`)
	) {
		compat.supportsMidConvoEffort = true;
	}
	if (provider === "anthropic" && supportsAnthropicMidConvoSystemMessages(modelId)) {
		compat.supportsMidConvoSystemMessages = true;
		compat.supportsMidConvoToolChanges = true;
	}
	// OpenCode Zen and GitHub Copilot forward mid-conversation system messages but reject
	// `tool_addition`/`tool_removal` blocks, so tool changes stay top-level there.
	if ((provider === "opencode" || provider === "github-copilot") && supportsAnthropicMidConvoSystemMessages(modelId)) {
		compat.supportsMidConvoSystemMessages = true;
	}
	if (EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS.has(`${provider}:${modelId}`)) {
		compat.supportsEagerToolInputStreaming = false;
	}
	if (provider === "xiaomi" || provider.startsWith("xiaomi-token-plan-")) {
		compat.allowEmptySignature = true;
	}
	// OpenCode Qwen 3.8 Flash emits and accepts thinking blocks with empty signatures.
	if ((provider === "opencode" || provider === "opencode-go") && modelId === "qwen3.8-flash") {
		compat.allowEmptySignature = true;
	}
	return Object.keys(compat).length > 0 ? compat : undefined;
}

function getBedrockBaseUrl(modelId: string): string {
	return modelId.startsWith("eu.")
		? "https://bedrock-runtime.eu-central-1.amazonaws.com"
		: "https://bedrock-runtime.us-east-1.amazonaws.com";
}

function getBedrockMantleOpenAIResponsesBaseUrl(modelId: string): string {
	return BEDROCK_MANTLE_OPENAI_RESPONSES_V1_MODEL_IDS.has(modelId)
		? "https://bedrock-mantle.us-east-1.api.aws/v1"
		: "https://bedrock-mantle.us-east-1.api.aws/openai/v1";
}

function isBedrockMantleOpenAIResponsesModelId(modelId: string): boolean {
	return BEDROCK_MANTLE_OPENAI_RESPONSES_MODEL_IDS.has(modelId);
}

function getBedrockMantleAnthropicMessagesBaseUrl(modelId: string): string {
	return BEDROCK_MANTLE_ANTHROPIC_MESSAGES_ROOT_MODEL_IDS.has(modelId)
		? "https://bedrock-mantle.us-east-1.api.aws"
		: "https://bedrock-mantle.us-east-1.api.aws/anthropic";
}

function isBedrockMantleAnthropicMessagesModelId(modelId: string): boolean {
	return BEDROCK_MANTLE_ANTHROPIC_MESSAGES_MODEL_IDS.has(modelId);
}

// These model-card entries are not yet present in models.dev's Bedrock catalog. Keep the normal
// models.dev metadata for IDs that upstream already publishes; only supplement missing model IDs here.
const BEDROCK_MANTLE_ANTHROPIC_MESSAGES_SUPPLEMENTAL_MODELS: Model<"anthropic-messages">[] = [
	{
		id: "anthropic.claude-mythos-5",
		name: "Claude Mythos 5",
		api: "anthropic-messages",
		provider: "amazon-bedrock",
		baseUrl: getBedrockMantleAnthropicMessagesBaseUrl("anthropic.claude-mythos-5"),
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "anthropic.claude-haiku-4-5",
		name: "Claude Haiku 4.5",
		api: "anthropic-messages",
		provider: "amazon-bedrock",
		baseUrl: getBedrockMantleAnthropicMessagesBaseUrl("anthropic.claude-haiku-4-5"),
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "anthropic.claude-mythos-preview",
		name: "Claude Mythos Preview",
		api: "anthropic-messages",
		provider: "amazon-bedrock",
		baseUrl: getBedrockMantleAnthropicMessagesBaseUrl("anthropic.claude-mythos-preview"),
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
];

const BEDROCK_MANTLE_OPENAI_RESPONSES_SUPPLEMENTAL_MODELS: Model<"openai-responses">[] = [
	{
		id: "google.gemma-4-31b",
		name: "Gemma 4 31B",
		api: "openai-responses",
		provider: "amazon-bedrock",
		baseUrl: getBedrockMantleOpenAIResponsesBaseUrl("google.gemma-4-31b"),
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 4096,
		compat: { sessionAffinityFormat: "openai-nosession", supportsStrictMode: true },
	},
	{
		id: "google.gemma-4-26b-a4b",
		name: "Gemma 4 26B-A4B",
		api: "openai-responses",
		provider: "amazon-bedrock",
		baseUrl: getBedrockMantleOpenAIResponsesBaseUrl("google.gemma-4-26b-a4b"),
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 4096,
		compat: { sessionAffinityFormat: "openai-nosession", supportsStrictMode: true },
	},
	{
		id: "google.gemma-4-e2b",
		name: "Gemma 4 E2B",
		api: "openai-responses",
		provider: "amazon-bedrock",
		baseUrl: getBedrockMantleOpenAIResponsesBaseUrl("google.gemma-4-e2b"),
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat: { sessionAffinityFormat: "openai-nosession", supportsStrictMode: true },
	},
	{
		id: "openai.gpt-5.6-cyber",
		name: "Daybreak Red: GPT-5.6 Cyber",
		api: "openai-responses",
		provider: "amazon-bedrock",
		baseUrl: getBedrockMantleOpenAIResponsesBaseUrl("openai.gpt-5.6-cyber"),
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 13.75, output: 82.5, cacheRead: 1.375, cacheWrite: 17.1875 },
		contextWindow: 272_000,
		maxTokens: 128_000,
		compat: { sessionAffinityFormat: "openai-nosession", supportsStrictMode: true },
	},
	{
		id: "openai.gpt-daybreak-blue-5.6-sol",
		name: "Daybreak Blue: GPT-5.6 Sol",
		api: "openai-responses",
		provider: "amazon-bedrock",
		baseUrl: getBedrockMantleOpenAIResponsesBaseUrl("openai.gpt-daybreak-blue-5.6-sol"),
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.875 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		compat: { sessionAffinityFormat: "openai-nosession", supportsStrictMode: true },
	},
];

function normalizeNvidiaModelId(modelId: string): string {
	return modelId.toLowerCase().replaceAll("_", ".");
}

function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

function getModelsDevCost(cost: ModelsDevModel["cost"]): ModelCost {
	const base = {
		input: cost?.input || 0,
		output: cost?.output || 0,
		cacheRead: cost?.cache_read || 0,
		cacheWrite: cost?.cache_write || 0,
	};
	// Rates a tier does not list keep the base price.
	const tiers = cost?.tiers?.flatMap((tier) => {
		const context = tier.tier;
		if (context?.type !== "context" || context.size === undefined) return [];
		return [
			{
				inputTokensAbove: context.size,
				input: tier.input ?? base.input,
				output: tier.output ?? base.output,
				cacheRead: tier.cache_read ?? base.cacheRead,
				cacheWrite: tier.cache_write ?? base.cacheWrite,
			},
		];
	});

	return tiers && tiers.length > 0 ? { ...base, tiers } : base;
}

async function fetchNvidiaNimModelIds(): Promise<Map<string, string>> {
	try {
		console.log("Fetching models from NVIDIA NIM API...");
		const response = await fetch(`${NVIDIA_BASE_URL}/models`);
		if (!response.ok) throw new Error(`NVIDIA NIM API returned ${response.status}`);
		const data = (await response.json()) as { data?: NvidiaNimModelListItem[] };
		const modelIds = new Map<string, string>();

		for (const model of data.data ?? []) {
			modelIds.set(model.id, model.id);
			modelIds.set(normalizeNvidiaModelId(model.id), model.id);
		}

		console.log(`Fetched ${data.data?.length ?? 0} model IDs from NVIDIA NIM`);
		return modelIds;
	} catch (error) {
		console.error("Failed to fetch NVIDIA NIM models:", error);
		if (generatorOptions.strict) throw error;
		return new Map();
	}
}

async function fetchOpenRouterList(query: string): Promise<OpenRouterModelListItem[]> {
	const response = await fetch(`https://openrouter.ai/api/v1/models${query}`);
	if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
	const data = (await response.json()) as { data?: OpenRouterModelListItem[] };
	return data.data ?? [];
}

async function fetchOpenRouterModels(): Promise<OpenRouterCatalog> {
	try {
		console.log("Fetching models from OpenRouter API...");
		const [listed, imageListed, decisionListed] = await Promise.all([
			fetchOpenRouterList(""),
			fetchOpenRouterList("?output_modalities=image"),
			fetchOpenRouterList("?output_modalities=decisions"),
		]);
		const catalog = buildOpenRouterCatalog(listed, imageListed, decisionListed);
		console.log(
			`Fetched ${catalog.chat.length} tool-capable, ${catalog.images.length} image, and ${catalog.classifiers.length} classifier models from OpenRouter`,
		);
		if (generatorOptions.strict && catalog.images.length === 0) {
			throw new Error("OpenRouter API returned no usable image models");
		}
		return catalog;
	} catch (error) {
		console.error("Failed to fetch OpenRouter models:", error);
		if (generatorOptions.strict) throw error;
		return { chat: [], images: [], classifiers: [] };
	}
}


async function fetchAiGatewayModels(): Promise<{
	chat: Model<any>[];
	classifiers: ClassifierModel<"typesafe-system-one">[];
}> {
	try {
		console.log("Fetching models from Vercel AI Gateway API...");
		const response = await fetch(`${AI_GATEWAY_MODELS_URL}/models`);
		if (!response.ok) throw new Error(`Vercel AI Gateway API returned ${response.status}`);
		const data = await response.json();
		const models: Model<any>[] = [];
		const classifiers: ClassifierModel<"typesafe-system-one">[] = [];

		const toNumber = (value: string | number | undefined): number => {
			if (typeof value === "number") {
				return Number.isFinite(value) ? value : 0;
			}
			const parsed = parseFloat(value ?? "0");
			return Number.isFinite(parsed) ? parsed : 0;
		};

		const items = Array.isArray(data.data) ? (data.data as AiGatewayModel[]) : [];
		for (const model of items) {
			// Evaluation models such as TypeSafe's Jev are served through the
			// TypeSafe-compatible System One endpoint.
			if (model.type === "evaluation") {
				classifiers.push({
					type: "classifier",
					id: model.id,
					name: model.name || model.id,
					api: "typesafe-system-one",
					provider: "vercel-ai-gateway",
					baseUrl: AI_GATEWAY_TYPESAFE_BASE_URL,
					input: ["text"],
					cost: {
						input: roundCost(toNumber(model.pricing?.input) * 1_000_000),
						output: roundCost(toNumber(model.pricing?.output) * 1_000_000),
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: model.context_window || 4096,
				});
				continue;
			}
			const tags = Array.isArray(model.tags) ? model.tags : [];
			// Only include models that support tools
			if (!tags.includes("tool-use")) continue;

			const input: ("text" | "image")[] = ["text"];
			if (tags.includes("vision")) {
				input.push("image");
			}

			models.push({
				id: model.id,
				name: model.name || model.id,
				api: "anthropic-messages",
				baseUrl: AI_GATEWAY_BASE_URL,
				provider: "vercel-ai-gateway",
				reasoning: tags.includes("reasoning"),
				input,
				compat: { allowEmptySignature: true },
				cost: getAiGatewayCost(model.pricing),
				contextWindow: model.context_window || 4096,
				maxTokens: model.max_tokens || 4096,
			});
		}

		console.log(
			`Fetched ${models.length} tool-capable and ${classifiers.length} classifier models from Vercel AI Gateway`,
		);
		return { chat: models, classifiers };
	} catch (error) {
		console.error("Failed to fetch Vercel AI Gateway models:", error);
		if (generatorOptions.strict) throw error;
		return { chat: [], classifiers: [] };
	}
}

function processZaiModels(data: ModelsDevCatalog): Model<Api>[] {
	const variants = [
		{
			source: "zai-coding-plan",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
		},
		{
			source: "zhipuai-coding-plan",
			provider: "zai-coding-cn",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		},
	] as const;
	const models: Model<Api>[] = [];

	for (const { source, provider, baseUrl } of variants) {
		for (const [modelId, model] of Object.entries(data[source]?.models ?? {})) {
			const m = model as ModelsDevModel;
			if (m.tool_call !== true) continue;
			const supportsImage = m.modalities?.input?.includes("image");

			const thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);
			const isGlm52 = modelId === "glm-5.2" || modelId === "glm-5.2-highspeed";
			if (thinkingLevelMap && isGlm52) {
				thinkingLevelMap.off = "none";
			}
			const supportsReasoningEffort = thinkingLevelMap !== undefined;
			const referenceCost = data.zai?.models[modelId]?.cost ?? m.cost;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider,
				baseUrl,
				reasoning: m.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: supportsImage ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(referenceCost),
				compat: {
					supportsDeveloperRole: false,
					thinkingFormat: "zai",
					...(supportsReasoningEffort ? { supportsReasoningEffort: true } : {}),
					...(!ZAI_TOOL_STREAM_UNSUPPORTED_MODELS.has(modelId) ? { zaiToolStream: true } : {}),
				},
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			recordModelsDevReasoningOptions(provider, modelId, m);
		}
	}

	return models;
}

function processBasetenModels(provider: ModelsDevProvider | undefined): Model<Api>[] {
	if (!provider?.models) return [];

	const baseUrl = "https://inference.baseten.co/v1";
	const baseCompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
		supportsStrictMode: true,
		// Baseten automatic prompt caching needs session affinity so related
		// requests land on the same replica. See:
		// https://docs.baseten.co/inference/model-apis/pricing-and-limits
		sendSessionAffinityHeaders: true,
		supportsLongCacheRetention: false,
	};
	const reasoningEffortCompat: OpenAICompletionsCompat = {
		...baseCompat,
		supportsReasoningEffort: true,
		thinkingFormat: "openai",
	};
	const toggleReasoningCompat: OpenAICompletionsCompat = {
		...baseCompat,
		thinkingFormat: "baseten",
		chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
	};
	const toggleReasoningEffortCompat: OpenAICompletionsCompat = {
		...reasoningEffortCompat,
		thinkingFormat: "baseten",
		chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
	};
	const toggleThinkingLevelMap = {
		off: "off",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	} as const;
	const glm52ThinkingLevelMap = {
		off: "none",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	} as const;
	const models: Model<Api>[] = [];

	for (const [modelId, model] of Object.entries(provider.models)) {
		if (model.status === "deprecated") continue;

		const reasoning = model.reasoning === true;
		const reasoningOptions = model.reasoning_options ?? [];
		const isGlm52 = modelId === "zai-org/GLM-5.2" || modelId === "zai-org/GLM-5.2-Fast";
		const supportsToggle = reasoningOptions.some((option) => option.type === "toggle") || isGlm52;
		const supportsEffort = reasoningOptions.some((option) => option.type === "effort") || isGlm52;
		const compat =
			supportsToggle && supportsEffort
				? toggleReasoningEffortCompat
				: supportsToggle
					? toggleReasoningCompat
					: supportsEffort
						? reasoningEffortCompat
						: baseCompat;
		const thinkingLevelMap = isGlm52
			? glm52ThinkingLevelMap
			: supportsToggle
				? toggleThinkingLevelMap
				: getEffortThinkingLevelMap(reasoningOptions);
		// Baseten's GLM-5.2 endpoints are text-only despite models.dev reporting image input.
		const supportsImageInput = !isGlm52 && model.modalities?.input?.includes("image");

		models.push({
			id: modelId,
			name: model.name || modelId,
			api: "openai-completions",
			provider: "baseten",
			baseUrl,
			reasoning,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: supportsImageInput ? ["text", "image"] : ["text"],
			cost: getModelsDevCost(model.cost),
			compat,
			contextWindow: model.limit?.context || 4096,
			maxTokens: model.limit?.output || 4096,
		});
	}

	return models;
}

function processGoogleModels(data: ModelsDevCatalog): Model<Api>[] {
	const models: Model<Api>[] = [];
	const googleModels = data.google?.models;
	if (googleModels) {
		for (const [modelId, model] of Object.entries(googleModels)) {
			if (model.tool_call !== true) continue;
			const source =
				modelId === "gemini-flash-latest"
					? (googleModels["gemini-3.5-flash"] ?? model)
					: modelId === "gemini-flash-lite-latest"
						? (googleModels["gemini-3.1-flash-lite"] ?? model)
						: model;
			const thinkingLevelMap = getGoogleThinkingLevelMap(modelId, source.reasoning_options ?? []);

			models.push({
				id: modelId,
				name: model.name || modelId,
				api: "google-generative-ai",
				provider: "google",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				reasoning: source.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(source.cost),
				contextWindow: source.limit?.context || 4096,
				maxTokens: source.limit?.output || 4096,
			});
		}
	}

	// The google-vertex models.dev catalog also includes Claude, OpenAI, and other
	// MaaS models that do not use the @google/genai Gemini streaming path.
	const vertexModels = data["google-vertex"]?.models;
	if (vertexModels) {
		for (const [modelId, model] of Object.entries(vertexModels)) {
			if (model.tool_call !== true || !modelId.startsWith("gemini-")) continue;
			if (modelId === "gemini-3.1-flash-lite-preview") continue;
			const source =
				modelId === "gemini-flash-latest"
					? (vertexModels["gemini-3.5-flash"] ?? model)
					: modelId === "gemini-flash-lite-latest"
						? (vertexModels["gemini-3.1-flash-lite"] ?? model)
						: model;
			const thinkingLevelMap = getGoogleThinkingLevelMap(modelId, source.reasoning_options ?? []);
			// models.dev reports Vertex cache_read/cache_write values for Gemini 2.5 Flash that
			// do not match the official Gemini API standard pricing table. nanopi only accounts
			// cachedContentTokenCount as cacheRead.
			const cacheRead = modelId === "gemini-2.5-flash" ? 0.03 : source.cost?.cache_read || 0;

			models.push({
				id: modelId,
				name: model.name || modelId,
				api: "google-vertex",
				provider: "google-vertex",
				baseUrl: VERTEX_BASE_URL,
				reasoning: source.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: {
					input: source.cost?.input || 0,
					output: source.cost?.output || 0,
					cacheRead,
					cacheWrite: 0,
				},
				contextWindow: source.limit?.context || 4096,
				maxTokens: source.limit?.output || 4096,
			});
		}
	}

	return models;
}

function processFireworksModels(provider: ModelsDevProvider | undefined): Model<Api>[] {
	if (!provider?.models) return [];

	const anthropicCompat: AnthropicMessagesCompat = {
		allowEmptySignature: true,
		sendSessionAffinityHeaders: true,
		supportsEagerToolInputStreaming: false,
		supportsCacheControlOnTools: false,
		supportsLongCacheRetention: false,
	};
	const openAICompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		sendSessionAffinityHeaders: true,
		supportsLongCacheRetention: false,
	};
	const kimiK3Compat: OpenAICompletionsCompat = {
		...openAICompat,
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "openai",
	};
	const models: Model<Api>[] = [];

	for (const [modelId, model] of Object.entries(provider.models)) {
		if (model.tool_call !== true) continue;

		const input: ("text" | "image")[] = model.modalities?.input?.includes("image")
			? ["text", "image"]
			: ["text"];
		const common = {
			id: modelId,
			name: model.name || modelId,
			provider: "fireworks",
			reasoning: model.reasoning === true,
			input,
			cost: getModelsDevCost(model.cost),
			contextWindow: model.limit?.context || 4096,
			maxTokens: model.limit?.output || 4096,
		};

		if (modelId.includes("glm-")) {
			models.push({
				...common,
				api: "openai-completions",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				compat: openAICompat,
			});
		} else if (modelId.includes("kimi-k3")) {
			models.push({
				...common,
				api: "openai-completions",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				compat: kimiK3Compat,
			});
		} else {
			models.push({
				...common,
				api: "anthropic-messages",
				// Fireworks Anthropic-compatible API - SDK appends /v1/messages.
				baseUrl: "https://api.fireworks.ai/inference",
				// Fireworks prompt caching uses automatic prefix matching + session affinity.
				// x-session-affinity routes requests to the same replica for cache hits.
				// cache_control on tools and eager_input_streaming are not supported.
				// See: https://docs.fireworks.ai/tools-sdks/anthropic-compatibility
				// Use adaptive thinking for cataloged effort controls, with verified
				// fallbacks where models.dev is incomplete. New models need no allowlist entry.
				compat: {
					...anthropicCompat,
					...(model.reasoning_options?.some((option) => option.type === "effort") ||
					FIREWORKS_ADAPTIVE_THINKING_FALLBACK_MODELS.has(modelId)
						? { forceAdaptiveThinking: true }
						: {}),
				},
			});
		}
		recordModelsDevReasoningOptions("fireworks", modelId, model);
	}

	return models;
}

async function loadModelsDevData(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		if (!response.ok) throw new Error(`models.dev API returned ${response.status}`);
		const data = (await response.json()) as ModelsDevCatalog;

		const models: Model<any>[] = [];
		const nvidiaNimModelIds = data.nvidia?.models ? await fetchNvidiaNimModelIds() : new Map<string, string>();

		// Process Amazon Bedrock models
		if (data["amazon-bedrock"]?.models) {
			for (const [modelId, model] of Object.entries(data["amazon-bedrock"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				let id = modelId;

				if (isBedrockMantleAnthropicMessagesModelId(id)) {
					models.push({
						id,
						name: m.name || id,
						api: "anthropic-messages" as const,
						provider: "amazon-bedrock" as const,
						baseUrl: getBedrockMantleAnthropicMessagesBaseUrl(id),
						reasoning: m.reasoning === true,
						input: (m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
						cost: {
							input: m.cost?.input || 0,
							output: m.cost?.output || 0,
							cacheRead: m.cost?.cache_read || 0,
							cacheWrite: m.cost?.cache_write || 0,
						},
						contextWindow: m.limit?.context || 4096,
						maxTokens: m.limit?.output || 4096,
					});
					recordModelsDevReasoningOptions("amazon-bedrock" as const, id, m);
					continue;
				}

				if (isBedrockMantleOpenAIResponsesModelId(id)) {
					models.push({
						id,
						name: m.name || id,
						api: "openai-responses" as const,
						provider: "amazon-bedrock" as const,
						baseUrl: getBedrockMantleOpenAIResponsesBaseUrl(id),
						reasoning: m.reasoning === true,
						input: (m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
						cost: {
							input: m.cost?.input || 0,
							output: m.cost?.output || 0,
							cacheRead: m.cost?.cache_read || 0,
							cacheWrite: m.cost?.cache_write || 0,
						},
						contextWindow: m.limit?.context || 4096,
						maxTokens: m.limit?.output || 4096,
						...(m.reasoning === true && { thinkingLevelMap: { off: null } }),
						compat: {
							sessionAffinityFormat: "openai-nosession" as const,
							...(m.structured_output === true && { supportsStrictMode: true }),
						},
					});
					recordModelsDevReasoningOptions("amazon-bedrock" as const, id, m);
					continue;
				}

				if (BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS.has(modelId)) continue;

				if (id.startsWith("ai21.jamba")) {
					// These models doesn't support tool use in streaming mode
					continue;
				}

				if (id.startsWith("mistral.mistral-7b-instruct-v0")) {
					// These models doesn't support system messages
					continue;
				}

				models.push({
					id,
					name: m.name || id,
					api: "bedrock-converse-stream" as const,
					provider: "amazon-bedrock" as const,
					baseUrl: getBedrockBaseUrl(id),
					reasoning: m.reasoning === true,
					input: (m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
					// Includes models.dev pricing tiers, e.g. the long-context tier for OpenAI models (#10326).
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(m.structured_output === true && { compat: { supportsStrictMode: true } }),
				});
				recordModelsDevReasoningOptions("amazon-bedrock" as const, id, m);
			}

			const bedrockModelIds = new Set(models.filter((model) => model.provider === "amazon-bedrock").map((model) => model.id));
			for (const model of BEDROCK_MANTLE_ANTHROPIC_MESSAGES_SUPPLEMENTAL_MODELS) {
				if (!bedrockModelIds.has(model.id)) {
					models.push(model);
				}
			}
			for (const model of BEDROCK_MANTLE_OPENAI_RESPONSES_SUPPLEMENTAL_MODELS) {
				if (!bedrockModelIds.has(model.id)) {
					models.push(model);
				}
			}
		}

		// Process Anthropic models
		if (data.anthropic?.models) {
			for (const [modelId, model] of Object.entries(data.anthropic.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("anthropic", modelId, m);
			}
		}

		models.push(...processGoogleModels(data));

		// Process OpenAI models
		if (data.openai?.models) {
			for (const [modelId, model] of Object.entries(data.openai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				// models.dev lists this alias, but it is not accepted by OpenAI APIs.
				if (MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS.has(modelId)) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("openai", modelId, m);
			}
		}

		// Process Groq models
		if (data.groq?.models) {
			for (const [modelId, model] of Object.entries(data.groq.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "groq",
					baseUrl: "https://api.groq.com/openai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("groq", modelId, m);
			}
		}

		// Process Cerebras models
		if (data.cerebras?.models) {
			for (const [modelId, model] of Object.entries(data.cerebras.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cerebras",
					baseUrl: "https://api.cerebras.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("cerebras", modelId, m);
			}
		}

		// Process Cloudflare Workers AI models
		if (data["cloudflare-workers-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cloudflare-workers-ai",
					baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: { sendSessionAffinityHeaders: true },
				});
				recordModelsDevReasoningOptions("cloudflare-workers-ai", modelId, m);
			}
		}

		// Process Cloudflare AI Gateway models
		const cloudflareAIGatewayModelIds = new Set<string>();
		if (data["cloudflare-ai-gateway"]?.models) {
			for (const [prefixedId, model] of Object.entries(data["cloudflare-ai-gateway"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const slashIdx = prefixedId.indexOf("/");
				if (slashIdx === -1) continue;
				const upstream = prefixedId.slice(0, slashIdx);
				const nativeId = prefixedId.slice(slashIdx + 1);

				let api: "anthropic-messages" | "openai-completions" | "openai-responses";
				let baseUrl: string;
				let id: string;
				if (upstream === "openai") {
					api = "openai-responses";
					baseUrl = CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL;
					id = nativeId;
				} else if (upstream === "anthropic") {
					api = "anthropic-messages";
					baseUrl = CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL;
					// The /anthropic passthrough forwards the model ID to Anthropic unchanged.
					// models.dev lists dotted versions (claude-opus-5.5), but Anthropic only
					// accepts dashed IDs (claude-opus-5-5).
					id = nativeId.replaceAll(".", "-");
				} else if (upstream === "workers-ai") {
					api = "openai-completions";
					baseUrl = CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL;
					id = prefixedId;
				} else {
					continue;
				}

				// Gateway passthroughs forward session affinity headers to upstreams that
				// use them for cache/routing affinity.
				const compat =
					upstream === "anthropic" || upstream === "workers-ai" ? { sendSessionAffinityHeaders: true } : undefined;

				cloudflareAIGatewayModelIds.add(id);
				models.push({
					id,
					name: m.name || id,
					api,
					provider: "cloudflare-ai-gateway",
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(compat ? { compat } : {}),
				});
				recordModelsDevReasoningOptions("cloudflare-ai-gateway", id, m);
			}
		}

		// The gateway proxies Workers AI through its OpenAI-compatible /compat endpoint,
		// but models.dev may omit or intermittently drop those `workers-ai/*` entries
		// from the AI Gateway catalog. Mirror the Workers AI catalog under the documented
		// prefix so the gateway keeps its OpenAI-compatible models stable.
		if (data["cloudflare-workers-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const id = `workers-ai/${modelId}`;
				if (cloudflareAIGatewayModelIds.has(id)) continue;
				cloudflareAIGatewayModelIds.add(id);

				models.push({
					id,
					name: m.name || id,
					api: "openai-completions",
					provider: "cloudflare-ai-gateway",
					baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: { sendSessionAffinityHeaders: true },
				});
				recordModelsDevReasoningOptions("cloudflare-ai-gateway", id, m);
			}
		}

		// Process xAi models
		if (data.xai?.models) {
			for (const [modelId, model] of Object.entries(data.xai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "xai",
					baseUrl: "https://api.x.ai/v1",
					compat: { ...XAI_RESPONSES_COMPAT },
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("xai", modelId, m);
			}
		}

		// Process Meta models
		if (data.meta?.models) {
			for (const [modelId, model] of Object.entries(data.meta.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "meta",
					baseUrl: "https://api.meta.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("meta", modelId, m);
			}
		}

		models.push(...processZaiModels(data));

		// Process Hugging Face models
		if (data.huggingface?.models) {
			for (const [modelId, model] of Object.entries(data.huggingface.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "huggingface",
					baseUrl: "https://router.huggingface.co/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					compat: {
						supportsDeveloperRole: false,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("huggingface", modelId, m);
			}
		}

		models.push(...processFireworksModels(data["fireworks-ai"]));

		// Process NVIDIA NIM models
		if (data.nvidia?.models) {
			for (const [modelId, model] of Object.entries(data.nvidia.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (!m.modalities?.input?.includes("text")) continue;
				if (!m.modalities?.output?.includes("text")) continue;

				const liveModelId = nvidiaNimModelIds.get(modelId) ?? nvidiaNimModelIds.get(normalizeNvidiaModelId(modelId));
				if (!liveModelId) continue;
				if (NVIDIA_NIM_UNSUPPORTED_MODELS.has(liveModelId)) continue;

				models.push({
					id: liveModelId,
					name: m.name || liveModelId,
					api: "openai-completions",
					provider: "nvidia",
					baseUrl: NVIDIA_BASE_URL,
					headers: { ...NVIDIA_HEADERS },
					reasoning: m.reasoning === true,
					input: m.modalities.input.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					compat: NVIDIA_OPENAI_COMPAT,
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("nvidia", liveModelId, m);
			}
		}

		// Process Together AI models
		const togetherProvider = data.together ?? data.togetherai ?? data["together-ai"];
		if (togetherProvider?.models) {
			for (const [modelId, model] of Object.entries(togetherProvider.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const reasoning = m.reasoning === true;
				const thinkingLevelMap = getTogetherThinkingLevelMap(modelId, reasoning);
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "together",
					baseUrl: TOGETHER_BASE_URL,
					reasoning,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					compat: getTogetherCompat(modelId, reasoning),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("together", modelId, m);
			}
		}

		models.push(...processBasetenModels(data.baseten));

		// Process SenseNova (China) models
		if (data.sensenova?.models) {
			for (const [modelId, model] of Object.entries(data.sensenova.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "sensenova",
					baseUrl: SENSENOVA_BASE_URL,
					compat: PLAIN_OPENAI_COMPAT,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("sensenova", modelId, m);
			}
		}

		// Process StepFun models (China and Global)
		const stepfunVariants = [
			{ source: "stepfun", provider: "stepfun", baseUrl: STEPFUN_CN_BASE_URL },
			{ source: "stepfun-ai", provider: "stepfun-ai", baseUrl: STEPFUN_GLOBAL_BASE_URL },
		] as const;

		for (const { source, provider, baseUrl } of stepfunVariants) {
			const providerModels = data[source]?.models;
			if (!providerModels) continue;

			for (const [modelId, model] of Object.entries(providerModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					compat: PLAIN_OPENAI_COMPAT,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(provider, modelId, m);
			}
		}

		// Process Modal models. The OpenAI-compatible Modal endpoint serves
		// open-weight models; models.dev publishes them under upstream ids.
		if (data.modal?.models) {
			for (const [modelId, model] of Object.entries(data.modal.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "modal",
					baseUrl: MODAL_BASE_URL,
					compat: PLAIN_OPENAI_COMPAT,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("modal", modelId, m);
			}
		}

		// Process OpenCode models (Zen and Go)
		// API mapping based on provider.npm field:
		// - @ai-sdk/openai → openai-responses
		// - @ai-sdk/anthropic → anthropic-messages
		// - @ai-sdk/google → google-generative-ai
		// - null/undefined/@ai-sdk/openai-compatible → openai-completions
		const opencodeVariants = [
			// Zen moved completions to /inference (2026-10): the legacy /zen paths
			// still serve GET /models but the free-tier gate rejects completion
			// requests there. models.dev now publishes https://opencode.ai/inference/v1.
			{ key: "opencode", provider: "opencode", basePath: "https://opencode.ai/inference" },
			{ key: "opencode-go", provider: "opencode-go", basePath: "https://opencode.ai/inference/go" },
		] as const;

		for (const variant of opencodeVariants) {
			if (!data[variant.key]?.models) continue;

			for (const [modelId, model] of Object.entries(data[variant.key].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const npm = m.provider?.npm;
				let api: Api;
				let baseUrl: string;
				let compat: OpenAICompletionsCompat | OpenAIResponsesCompat | undefined;

				if (npm === "@ai-sdk/openai") {
					api = "openai-responses";
					baseUrl = `${variant.basePath}/v1`;
					compat = { sessionAffinityFormat: "openai-nosession" };
				} else if (npm === "@ai-sdk/anthropic") {
					api = "anthropic-messages";
					// Anthropic SDK appends /v1/messages to baseURL
					baseUrl = variant.basePath;
				} else if (npm === "@ai-sdk/google") {
					api = "google-generative-ai";
					baseUrl = `${variant.basePath}/v1`;
				} else if (npm === "@ai-sdk/alibaba") {
					api = "openai-completions";
					baseUrl = `${variant.basePath}/v1`;
					compat = { cacheControlFormat: "anthropic" };
				} else {
					// null, undefined, or @ai-sdk/openai-compatible
					api = "openai-completions";
					baseUrl = `${variant.basePath}/v1`;
				}

				if (variant.provider === "opencode" && modelId === "grok-build-0.1") {
					compat = { ...(compat ?? {}), supportsReasoningEffort: false };
				}

				if ((variant.provider === "opencode" || variant.provider === "opencode-go") && modelId === "kimi-k2.6") {
					// OpenCode Kimi K2.6 accepts Anthropic-style thinking objects
					// and rejects string thinking values or combined reasoning_effort.
					compat = { ...(compat ?? {}), thinkingFormat: "deepseek", supportsReasoningEffort: false };
				}

				// Fix known mismatches between models.dev npm data and actual
				// OpenCode Go endpoint behaviour. models.dev reports these models
				// as @ai-sdk/anthropic, but the OpenCode Go endpoints either don't
				// accept Anthropic SDK auth (MiniMax M2.7) or are served through
				// the OpenAI-compatible /v1/chat/completions path (Qwen 3.5/3.6).
				// Switch them to openai-completions so requests use Bearer auth
				// and the standard /v1/chat/completions endpoint.
				if (variant.provider === "opencode-go") {
					if (modelId === "minimax-m2.7") {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/v1`;
					}
					if (modelId === "qwen3.5-plus" || modelId === "qwen3.6-plus") {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/v1`;
						// Qwen/DashScope uses enable_thinking at the top level.
						compat = { ...(compat ?? {}), thinkingFormat: "qwen" };
					}
				}

				if (api === "openai-completions") {
					compat = { ...(compat ?? {}), maxTokensField: "max_tokens" };
					if (
						OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS.has(
							`${variant.provider}:${modelId}`,
						)
					) {
						compat = { ...compat, supportsLongCacheRetention: false };
					}
				}

				let thinkingLevelMap: NonNullable<Model<Api>["thinkingLevelMap"]> | undefined;
				if (api === "google-generative-ai") {
					thinkingLevelMap = getGoogleThinkingLevelMap(modelId, m.reasoning_options ?? []);
				} else if (variant.provider === "opencode-go" && modelId === "deepseek-v4.1-flash") {
					thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);
				}
				models.push({
					id: modelId,
					name: m.name || modelId,
					api,
					provider: variant.provider,
					baseUrl,
					reasoning: m.reasoning === true,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					...(compat ? { compat } : {}),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(variant.provider, modelId, m);
			}
		}

		// Process GitHub Copilot models
		if (data["github-copilot"]?.models) {
			for (const [modelId, model] of Object.entries(data["github-copilot"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				// Claude 4.x and 5.x models route to Anthropic Messages API
				const isCopilotClaude = /^claude-(haiku|sonnet|opus|fable)-[45]([.\-]|$)/.test(modelId);
				// GPT, Grok, OSWE, and MAI-Code models are only served through
				// the Copilot /responses endpoint.
				const needsResponsesApi =
					modelId.startsWith("gpt-") ||
					modelId.startsWith("grok-") ||
					modelId.startsWith("oswe") ||
					modelId.startsWith("mai-");

				const api: Api = isCopilotClaude
					? "anthropic-messages"
					: needsResponsesApi
						? "openai-responses"
						: "openai-completions";

				const anthropicCompat =
					api === "anthropic-messages" ? getAnthropicMessagesCompat("github-copilot", modelId) : undefined;

				const copilotModel: Model<any> = {
					id: modelId,
					name: m.name || modelId,
					api,
					provider: "github-copilot",
					baseUrl: "https://api.individual.githubcopilot.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 128000,
					maxTokens: m.limit?.output || 8192,
					headers: { ...COPILOT_STATIC_HEADERS },
					...(anthropicCompat ? { compat: anthropicCompat } : {}),
					// compat only applies to openai-completions
					...(api === "openai-completions" ? {
						compat: {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
						},
					} : {}),
				};

				models.push(copilotModel);
				recordModelsDevReasoningOptions("github-copilot", modelId, m);
			}
		}

		// Process Kimi For Coding models
		if (data["kimi-code-plan-global"]?.models) {
			const kimiModels = data["kimi-code-plan-global"].models as Record<string, ModelsDevModel>;
			const hasCanonicalModel = Object.prototype.hasOwnProperty.call(kimiModels, "kimi-for-coding");

			const kimiAliases = new Set(["k2p5", "k2p6", "k2p7"]);

			for (const [modelId, model] of Object.entries(kimiModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				// models.dev may expose versioned aliases (e.g. k2p5/k2p6/k2p7).
				// Normalize aliases to the canonical model id and drop duplicates when canonical exists.
				if (kimiAliases.has(modelId) && hasCanonicalModel) continue;

				const normalizedId = kimiAliases.has(modelId) ? "kimi-for-coding" : modelId;
				const normalizedName = kimiAliases.has(modelId) ? "Kimi For Coding" : m.name || normalizedId;
				const isKimiK3 = normalizedId === "k3";
				const allowEmptySignature = isKimiK3 || normalizedId === "kimi-for-coding";
				const impliedCost = KIMI_CODING_IMPLIED_COSTS[normalizedId];

				models.push({
					id: normalizedId,
					name: normalizedName,
					api: "anthropic-messages",
					provider: "kimi-coding",
					// Kimi For Coding's Anthropic-compatible API - SDK appends /v1/messages
					baseUrl: "https://api.kimi.com/coding",
					compat: {
						...(allowEmptySignature ? { allowEmptySignature: true } : {}),
						forceAdaptiveThinking: true,
					},
					reasoning: isKimiK3 || m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || impliedCost?.input || 0,
						output: m.cost?.output || impliedCost?.output || 0,
						cacheRead: m.cost?.cache_read || impliedCost?.cacheRead || 0,
						cacheWrite: m.cost?.cache_write || impliedCost?.cacheWrite || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("kimi-coding", normalizedId, m);
			}
		}

		// Process Moonshot AI models
		const moonshotVariants = [
			{ key: "moonshotai", provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" },
			{ key: "moonshotai-cn", provider: "moonshotai-cn", baseUrl: "https://api.moonshot.cn/v1" },
		] as const;
		const moonshotCompat: OpenAICompletionsCompat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			thinkingFormat: "deepseek",
		};
		const getMoonshotProviderModels = (key: "moonshotai" | "moonshotai-cn"): Record<string, ModelsDevModel> => {
			const providerModels = data[key]?.models as Record<string, ModelsDevModel> | undefined;
			return providerModels ? { ...providerModels } : {};
		};
		const moonshotModels = {
			moonshotai: getMoonshotProviderModels("moonshotai"),
			"moonshotai-cn": getMoonshotProviderModels("moonshotai-cn"),
		};

		for (const { key, provider, baseUrl } of moonshotVariants) {
			for (const [modelId, m] of Object.entries(moonshotModels[key])) {
				if (m.tool_call !== true) continue;

				const isKimiK3 = modelId === "kimi-k3";
				const compat = isKimiK3 ? { ...moonshotCompat } : moonshotCompat;
				if (isKimiK3) {
					compat.requiresReasoningContentOnAssistantMessages = true;
					compat.thinkingFormat = "openai";
					compat.supportsReasoningEffort = true;
				}
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					reasoning: isKimiK3 || m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					// Moonshot does not bill cache writes; models.dev lists the input rate as cache_write for Kimi K3.
					cost: isKimiK3
						? { ...KIMI_K3_COST }
						: {
								input: m.cost?.input || 0,
								output: m.cost?.output || 0,
								cacheRead: m.cost?.cache_read || 0,
								cacheWrite: m.cost?.cache_write || 0,
							},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat,
				});
				recordModelsDevReasoningOptions(provider, modelId, m);
			}
		}

		// Process Xiaomi MiMo models
		// Built-in `xiaomi` targets the API billing endpoint (single stable URL,
		// keys from platform.xiaomimimo.com). The three `xiaomi-token-plan-*`
		// providers cover prepaid Token Plan endpoints in cn / ams / sgp.
		const xiaomiCompat: OpenAICompletionsCompat = {
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
		};
		const xiaomiVariants = [
			{ source: "xiaomi", provider: "xiaomi", baseUrl: "https://api.xiaomimimo.com/v1" },
			{
				source: "xiaomi-token-plan-cn",
				provider: "xiaomi-token-plan-cn",
				baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
			},
			{
				source: "xiaomi-token-plan-ams",
				provider: "xiaomi-token-plan-ams",
				baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
			},
			{
				source: "xiaomi-token-plan-sgp",
				provider: "xiaomi-token-plan-sgp",
				baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
			},
		] as const;

		for (const { source, provider, baseUrl } of xiaomiVariants) {
			const providerModels = data[source]?.models;
			if (!providerModels) continue;

			for (const [modelId, model] of Object.entries(providerModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					compat: xiaomiCompat,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(provider, modelId, m);
			}
		}

		// Process Alibaba Cloud Model Studio Token Plan models. International and
		// China use separate endpoints and API keys (sk-sp- prefix). The Individual
		// provider reuses the international source and endpoint with a narrower catalog.
		// models.dev keys are "alibaba-token-plan[-cn]"; nanopi exposes them as
		// "qwen-token-plan[-cn]" plus the Individual catalog view.
		const qwenTokenPlanCompat: OpenAICompletionsCompat = {
			thinkingFormat: "qwen",
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: true,
		};
		const qwenTokenPlanVariants = [
			{
				source: "alibaba-token-plan",
				provider: "qwen-token-plan",
				baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
				modelIds: undefined,
			},
			{
				source: "alibaba-token-plan",
				provider: "qwen-token-plan-individual",
				baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
				modelIds: QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS,
			},
			{
				source: "alibaba-token-plan-cn",
				provider: "qwen-token-plan-cn",
				baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
				modelIds: undefined,
			},
		] as const;

		for (const { source, provider, baseUrl, modelIds } of qwenTokenPlanVariants) {
			const providerModels = data[source]?.models;
			const emittedModelIds = modelIds ? new Set<string>() : undefined;

			for (const [modelId, model] of Object.entries(providerModels ?? {})) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (QWEN_TOKEN_PLAN_EXCLUDED_MODEL_IDS.has(modelId)) continue;
				if (modelIds && !modelIds.has(modelId)) continue;
				const thinkingLevelMap =
					getEffortThinkingLevelMap(m.reasoning_options ?? []) ??
					(QWEN_TOKEN_PLAN_REASONING_EFFORT_FALLBACK_MODEL_IDS.has(modelId)
						? QWEN_TOKEN_PLAN_FALLBACK_THINKING_LEVEL_MAP
						: undefined);

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					compat: thinkingLevelMap
						? qwenTokenPlanCompat
						: { ...qwenTokenPlanCompat, supportsReasoningEffort: false },
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				emittedModelIds?.add(modelId);
			}

			if (modelIds && emittedModelIds && generatorOptions.strict) {
				assertExactModelIds(provider, modelIds, emittedModelIds);
			}
		}

		// `zai` / `zhipuai` serve the same GLM models as their coding-plan keys over
		// a different endpoint. `siliconflow-cn` / `siliconflow` and
		// `alibaba-token-plan` / `alibaba-token-plan-cn` are separate regional keys.
		// These are the only direct models.dev providers shipped as built-ins.
		for (const providerId of DIRECT_MODELS_DEV_PROVIDERS) {
			const provider = data[providerId];
			if (!provider?.api) continue;
			for (const [modelId, model] of Object.entries(provider.models ?? {})) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: providerId,
					baseUrl: provider.api,
					compat: PLAIN_OPENAI_COMPAT,
					reasoning: m.reasoning === true,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(providerId, modelId, m);
			}
		}

		// Ollama Cloud token plan: the subscription entry point to `ollama-cloud`'s
		// catalog. Same endpoint and models, separate key so both can be configured.
		for (const [modelId, model] of Object.entries(data[OLLAMA_CLOUD_TOKEN_PLAN_SOURCE]?.models ?? {})) {
			const m = model as ModelsDevModel;
			if (m.tool_call !== true) continue;
			if (m.status === "deprecated") continue;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider: "ollama-cloud-token-plan",
				baseUrl: OLLAMA_CLOUD_TOKEN_PLAN_BASE_URL,
				compat: PLAIN_OPENAI_COMPAT,
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			recordModelsDevReasoningOptions("ollama-cloud-token-plan", modelId, m);
		}

		// Every remaining models.dev provider that speaks the OpenAI-compatible
		// protocol. models.dev spells the endpoint in `api`; skip providers that use a
		// dedicated branch above, duplicate another key's endpoint, or need build-time
		// substitution in the URL. A provider that ships no tool-capable model would
		// only add noise to the catalog, so it is skipped as well.
		for (const [providerId, provider] of Object.entries(data)) {
			if (EXPLICIT_MODELS_DEV_PROVIDERS.has(providerId)) continue;
			if (DUPLICATE_MODELS_DEV_PROVIDERS.has(providerId)) continue;
			if (UNSUPPORTED_MODELS_DEV_PROVIDERS.has(providerId)) continue;
			if (provider.npm !== "@ai-sdk/openai-compatible") continue;
			if (!provider.api || provider.api.includes("${")) continue;

			const providerModels = provider.models;
			if (!providerModels) continue;

			for (const [modelId, model] of Object.entries(providerModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: providerId,
					baseUrl: provider.api,
					compat: PLAIN_OPENAI_COMPAT,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(providerId, modelId, m);
			}
		}

		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

async function loadModelsDevClassifierModels(): Promise<ClassifierModel<"typesafe-system-one">[]> {
	try {
		console.log("Fetching classifier models from models.dev API...");
		const response = await fetch("https://models.dev/models.json?type=decision");
		if (!response.ok) throw new Error(`models.dev classifier API returned ${response.status}`);
		const data = (await response.json()) as Record<string, ModelsDevMetadata>;
		const metadata = data["typesafe/jev-latest"];
		if (!metadata || metadata.type !== "decision") {
			throw new Error("models.dev did not return decision model typesafe/jev-latest");
		}
		return [
			{
				type: "classifier",
				id: "jev-latest",
				name: metadata.name,
				api: "typesafe-system-one",
				provider: "typesafe",
				baseUrl: "https://api.typesafe.ai/v1/",
				input: metadata.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				// The canonical models.dev entry has no direct-provider pricing. System One reports token usage,
				// so classify() results carry token counts but price them at zero.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: metadata.limit?.context || 64000,
			},
		];
	} catch (error) {
		console.error("Failed to load models.dev classifier data:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

// Workers AI has no unauthenticated catalog and models.dev does not list its
// System One models yet. Cloudflare publishes pricing only in the dashboard.
// https://developers.cloudflare.com/ai/models/typesafe/jev/
// OpenCode Zen serves Jev through its TypeSafe-compatible System One endpoint.
// Neither its /inference/v1/models listing nor models.dev carries metadata for it.
// https://opencode.ai/docs/zen
const OPENCODE_CLASSIFIER_MODELS: ClassifierModel<"typesafe-system-one">[] = [
	{
		type: "classifier",
		id: "jev-1.13",
		name: "Jev 1.13",
		api: "typesafe-system-one",
		provider: "opencode",
		baseUrl: "https://opencode.ai/inference/v1",
		input: ["text"],
		cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	},
	{
		type: "classifier",
		id: "jev-1.13-free",
		name: "Jev 1.13 Free",
		api: "typesafe-system-one",
		provider: "opencode",
		baseUrl: "https://opencode.ai/inference/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	},
];

const CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS: ClassifierModel<"cloudflare-workers-ai-system-one">[] = [
	// Cloudflare-hosted Clef decision models. They accept images, but classifier
	// contexts carry text or JSON state only, so the catalog advertises text.
	// Pricing: https://developers.cloudflare.com/workers-ai/models/clef/
	// and https://developers.cloudflare.com/workers-ai/models/clef-flash/
	{
		type: "classifier",
		id: "@cf/cloudflare/clef",
		name: "Clef",
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text"],
		cost: { input: 0.24, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65536,
	},
	{
		type: "classifier",
		id: "@cf/cloudflare/clef-flash",
		name: "Clef Flash",
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text"],
		cost: { input: 0.09, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 65536,
	},
	{
		type: "classifier",
		id: "typesafe/jev",
		name: "Jev",
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	},
];

// OpenAI Decisions API (public beta): gpt-6-luna is its only model. It bills input tokens only,
// with the same long-context multiplier as chat requests. Only API keys work: Sign in with ChatGPT
// tokens are rejected on /v1/decisions, and the Codex backend has no Decisions route.
// The endpoint rejects inputs above 922K tokens (the model's documented maximum input), but
// requests running longer than about five seconds, currently above roughly 600K input tokens,
// fail with a gateway timeout.
// https://developers.openai.com/api/docs/guides/decisions
const OPENAI_CLASSIFIER_MODELS: ClassifierModel<"openai-decisions">[] = [
	{
		type: "classifier",
		id: "gpt-6-luna",
		name: "GPT-6 Luna",
		api: "openai-decisions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		input: ["text", "image"],
		cost: withOpenAiLongContextPricing({ input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 }),
		contextWindow: 922000,
	},
];

const GENERATED_HEADER = `// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update

`;

// A catalog constant is a TS identifier, so prefix ids that would start with a
// digit (`302ai` yields `_302AI_MODELS`).
const catalogConstPrefix = (providerId: string) => {
	const name = providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	return /^[0-9]/.test(name) ? `_${name}` : name;
};
const catalogConstName = (providerId: string) => `${catalogConstPrefix(providerId)}_MODELS`;
const imageCatalogConstName = (providerId: string) => `${catalogConstPrefix(providerId)}_IMAGE_MODELS`;
const classifierCatalogConstName = (providerId: string) => `${catalogConstPrefix(providerId)}_CLASSIFIER_MODELS`;
const providerArtifactConstName = (providerId: string) => providerArtifactName(providerId).toUpperCase().replace(/[^A-Z0-9]+/g, "_");

/**
 * One provider's catalog shard. The catalogs sit behind a `.value` export so the
 * aggregator can import their types statically while loading their data lazily:
 * `typeof IMPORT[name]` needs the static import, so a build whose provider set
 * drops a catalog can swap this module for the stand-in under
 * `src/providers/disabled/` (see scripts/build-apis.mjs) and keep the type.
 *
 * The stand-in declares the same exports with a `DisabledModelCatalog` type, so
 * provider keys stay literal-typed and only the model reads lose their type.
 */
function providerShard(providerId: string): string {
	let output = GENERATED_HEADER;
	output += `import values from "./data/${providerArtifactName(providerId)}.json" with { type: "json" };\n`;
	output += `import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";\n\n`;
	output += `export const ${catalogConstName(providerId)}: ChatModelCatalog<typeof values, ${JSON.stringify(providerId)}> =\n`;
	output += `\tflattenChatModelCatalog(${JSON.stringify(providerId)}, values);\n\n`;
	output += `export const ${imageCatalogConstName(providerId)}: ImageModelCatalog<typeof values, ${JSON.stringify(providerId)}> =\n`;
	output += `\tflattenImageModelCatalog(${JSON.stringify(providerId)}, values);\n\n`;
	output += `export const ${classifierCatalogConstName(providerId)}: ClassifierModelCatalog<typeof values, ${JSON.stringify(providerId)}> =\n`;
	output += `\tflattenClassifierModelCatalog(${JSON.stringify(providerId)}, values);\n\n`;
	// The aggregator imports the type from this module and the value through the
	// namespace proxy, so each catalog is published twice: as a type and lazily.
	output += `export const value = {\n`;
	output += `\tget ${catalogConstName(providerId)}() {\n`;
	output += `\t\treturn ${catalogConstName(providerId)};\n`;
	output += `\t},\n`;
	output += `\tget ${imageCatalogConstName(providerId)}() {\n`;
	output += `\t\treturn ${imageCatalogConstName(providerId)};\n`;
	output += `\t},\n`;
	output += `\tget ${classifierCatalogConstName(providerId)}() {\n`;
	output += `\t\treturn ${classifierCatalogConstName(providerId)};\n`;
	output += `\t},\n`;
	output += `};\n`;
	return output;
}

/**
 * The stand-in a trimmed build swaps this shard for
 * (`src/providers/disabled/<provider>-models.ts`, aliased by
 * scripts/build-apis.mjs). It lives next to the shard because it has to track
 * the shard's export names: the catalogs are per provider, and a provider
 * models.dev adds would otherwise fail the release build in `validateStubs`
 * with a file nobody wrote.
 *
 * The build refuses to substitute a module whose stand-in is missing, and the
 * stand-in is only read when the provider is dropped, so writing one per
 * generated shard costs a few hundred bytes of source and no bundle bytes.
 */
function providerStub(providerId: string): string {
	const artifact = providerArtifactName(providerId);
	let output = `/**
 * Stand-in for \`${artifact}.models.ts\` in a build whose provider set leaves
 * ${providerId} out (buildconfig.json \`providerSets\`).
 *
 * Generated by scripts/generate-models.ts; do not edit. Both the named exports
 * and the \`value\` object keep their names, so \`models.generated.ts\` compiles
 * unchanged: the provider key stays literal-typed and only the model reads lose
 * their type (\`DisabledModelCatalog\`).
 */

import type { DisabledModelCatalog } from "../../model-catalog.ts";

export const ${catalogConstName(providerId)}: DisabledModelCatalog = {};

export const ${imageCatalogConstName(providerId)}: DisabledModelCatalog = {};

export const ${classifierCatalogConstName(providerId)}: DisabledModelCatalog = {};

export const value = {
	${catalogConstName(providerId)},
	${imageCatalogConstName(providerId)},
	${classifierCatalogConstName(providerId)},
};
`;
	return output;
}

/**
 * The aggregator module: one map per model type, keyed by provider.
 *
 * Each shard is imported as a namespace and read twice, on purpose:
 *
 * - `typeof IMPORT[k]["<SHARD>_MODELS"]` is a type-only use, erased by tsc and
 *   esbuild, and it is what keeps `getBuiltinModel("openai", "gpt-4o")`
 *   narrowing on the literal catalog type.
 * - `IMPORT[k].value["<SHARD>_MODELS"]` is the runtime read, through getters on
 *   the shard's `value` export. Importing the namespace does not evaluate the
 *   module, so a provider set that drops a catalog only pays for its stand-in
 *   (scripts/build-apis.mjs), and a build that ships every catalog still reads
 *   model data lazily instead of at import time.
 */
function modelAggregator(providerIds: readonly string[]): string {
	const maps: Array<[string, (providerId: string) => string]> = [
		["MODELS", catalogConstName],
		["IMAGE_MODELS", imageCatalogConstName],
		["CLASSIFIER_MODELS", classifierCatalogConstName],
	];
	let output = GENERATED_HEADER;
	for (const providerId of providerIds) {
		// The module name loses dots (`llama.cpp` → `llama-cpp`), so the id is
		// recorded here for `model-data.ts`, which reads provider ids back out.
		output += `// provider-id: ${providerId}\n`;
		output += `import * as IMPORT_${providerArtifactConstName(providerId)} from "./providers/${providerArtifactName(providerId)}.models.ts";\n`;
	}
	for (const [mapName, constName] of maps) {
		output += `\nexport const ${mapName}: {\n`;
		for (const providerId of providerIds) {
			output += `\treadonly ${JSON.stringify(providerId)}: typeof IMPORT_${providerArtifactConstName(providerId)}[${JSON.stringify(constName(providerId))}];\n`;
		}
		output += `} = {\n`;
		for (const providerId of providerIds) {
			output += `\t${JSON.stringify(providerId)}: IMPORT_${providerArtifactConstName(providerId)}.value[${JSON.stringify(constName(providerId))}],\n`;
		}
		output += `};\n`;
	}
	return output;
}

/**
 * Writes the empty catalog a no-provider build ships: no shard, an aggregator
 * with empty maps, and a data directory holding only the manifest. Callers that
 * read the generated state (the shard check, the hydration step, the runtime)
 * keep working against zero providers instead of special-casing them.
 */
function writeEmptyCatalog(): void {
	const providersDir = join(packageRoot, "src", "providers");
	const dataDir = join(providersDir, "data");
	const aggregatorPath = join(packageRoot, "src", "models.generated.ts");
	for (const entry of readdirSync(providersDir)) {
		if (entry.endsWith(".models.ts")) rmSync(join(providersDir, entry));
	}
	// No shard, so no shard to stand in for: the disabled directory holds the
	// per-provider stubs (`providerStub`) and nothing else.
	const disabledDir = join(providersDir, "disabled");
	for (const entry of readdirSync(disabledDir)) {
		if (entry.endsWith("-models.ts")) rmSync(join(disabledDir, entry));
	}
	writeFileSync(
		aggregatorPath,
		`// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update
//
// This build ships no built-in provider: every model comes from models.json.
${EMPTY_CATALOG_MARKER}

export const MODELS: Record<string, never> = {};

export const IMAGE_MODELS: Record<string, never> = {};

export const CLASSIFIER_MODELS: Record<string, never> = {};
`,
	);
	mkdirSync(dataDir, { recursive: true });
	for (const entry of readdirSync(dataDir)) {
		if (entry.endsWith(".json")) rmSync(join(dataDir, entry));
	}
	// No provider data, so the manifest records the empty structure and no files.
	// The end-of-run cross-check reads the shard set out of the aggregator, which
	// this run just emptied, so it is skipped here and the shards themselves are
	// gone: nothing is left to disagree with.
	const manifest = createModelDataManifest({}, {}, new Date().toISOString());
	writeFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);


	console.log("Generated an empty provider catalog (the build ships no built-in provider)");
}

async function generateModels() {
	// A run with no provider writes the empty catalog and touches no network:
	// fetching every upstream catalog to then drop it would make a small build
	// depend on all of them being reachable.
	if (selectProviderIds(["*"]).length === 0) {
		writeEmptyCatalog();
		return;
	}
	// Fetch models from all upstream catalogs.
	// models.dev: Anthropic, Google, OpenAI, Groq, Cerebras, and others
	// OpenRouter: its tool-capable routed catalog
	// AI Gateway: OpenAI-compatible catalog with tool-capable models
	const modelsDevModels = await loadModelsDevData();
	const modelsDevClassifierModels = await loadModelsDevClassifierModels();
	const openRouterCatalog = await fetchOpenRouterModels();
	const aiGatewayCatalog = await fetchAiGatewayModels();

	// Combine chat models (models.dev has priority where sources overlap).
	const allModels = [...modelsDevModels, ...openRouterCatalog.chat, ...aiGatewayCatalog.chat].filter(
		(model) =>
			!(model.provider === "xai" && XAI_BUILTIN_EXCLUDED_MODEL_IDS.has(model.id)) &&
			!((model.provider === "opencode" || model.provider === "opencode-go") && model.id === "gpt-5.3-codex-spark"),
	);

	// The authenticated Copilot catalog advertised these models on 2026-09-22,
	// but models.dev did not include them yet.
	const missingCopilotModels: Model<Api>[] = [
		{
			id: "claude-opus-5.5",
			name: "Claude Opus 5.5",
			api: "anthropic-messages",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
			contextWindow: 1000000,
			maxTokens: 128000,
			headers: { ...COPILOT_STATIC_HEADERS },
		},
		...(["gpt-6-sol", "gpt-6-luna"] as const).map((id) => ({
			id,
			name: id === "gpt-6-sol" ? "GPT-6 Sol" : "GPT-6 Luna",
			api: "openai-responses" as const,
			provider: "github-copilot" as const,
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS[id]),
			contextWindow: 1000000,
			maxTokens: 128000,
			headers: { ...COPILOT_STATIC_HEADERS },
		})),
	];
	for (const model of missingCopilotModels) {
		if (!allModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
			allModels.push(model);
		}
	}

	// Temporary overrides until upstream model metadata is corrected.
	for (const candidate of allModels) {
		if (candidate.provider === "github-copilot" && GITHUB_COPILOT_EXTENDED_CONTEXT_MODELS.has(candidate.id)) {
			candidate.contextWindow = 1000000;
		}

		// models.dev may list Opus 5.5, Sonnet 5.5, and Haiku 5.5 before their effort metadata is complete.
		if (
			(candidate.provider === "anthropic" &&
				(candidate.id === "claude-opus-5-5" ||
					candidate.id === "claude-sonnet-5-5" ||
					candidate.id === "claude-haiku-5-5")) ||
			(candidate.provider === "github-copilot" && candidate.id === "claude-opus-5.5")
		) {
			mergeThinkingLevelMap(candidate, {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			});
		}

		if (
			(candidate.provider === "anthropic" ||
				candidate.provider === "opencode" ||
				candidate.provider === "opencode-go") &&
			(candidate.id === "claude-opus-4-6" ||
				candidate.id === "claude-sonnet-4-6" ||
				candidate.id === "claude-opus-4.6" ||
				candidate.id === "claude-sonnet-4.6")
		) {
			candidate.contextWindow = 1000000;
		}

		// OpenCode variants list Claude Sonnet 4/4.5 with 1M context, actual limit is 200K
		if (
			(candidate.provider === "opencode" || candidate.provider === "opencode-go") &&
			(candidate.id === "claude-sonnet-4-5" || candidate.id === "claude-sonnet-4")
		) {
			candidate.contextWindow = 200000;
		}
		if ((candidate.provider === "opencode" || candidate.provider === "opencode-go") && candidate.id === "gpt-5.4") {
			candidate.contextWindow = 272000;
			candidate.maxTokens = 128000;
		}
		// Keep direct OpenAI requests in the short-context pricing tier by default. Users can opt into the
		// larger context through model overrides, so retain long-context cost metadata on the capped models.
		if (candidate.provider === "openai" && OPENAI_SHORT_CONTEXT_CAPPED_MODEL_IDS.has(candidate.id)) {
			candidate.contextWindow = OPENAI_LONG_CONTEXT_INPUT_THRESHOLD;
			candidate.maxTokens = 128000;
		}
		if (candidate.provider === "openai" && OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS.has(candidate.id)) {
			const standardCost = OPENAI_STANDARD_COSTS[candidate.id];
			candidate.cost = withOpenAiLongContextPricing(standardCost ?? candidate.cost);
		}
		// Cloudflare AI Gateway passes OpenAI usage through at OpenAI list prices.
		if (candidate.provider === "cloudflare-ai-gateway") {
			const standardCost = OPENAI_STANDARD_COSTS[candidate.id];
			if (standardCost) candidate.cost = withOpenAiLongContextPricing(standardCost);
		}
		// models.dev reports gpt-5-pro output as 272000 (a duplicate of the input sub-limit);
		// the actual max output is 128000. Also propagates to the derived Azure clone.
		if (candidate.provider === "openai" && candidate.id === "gpt-5-pro") {
			candidate.maxTokens = 128000;
		}
		// Keep Kimi K3's canonical output limit when gateway metadata is missing or incorrect.
		if (
			(candidate.provider === "openrouter" && OPENROUTER_KIMI_K3_MODEL_IDS.has(candidate.id)) ||
			(candidate.provider === "vercel-ai-gateway" && candidate.id === "moonshotai/kimi-k3")
		) {
			candidate.maxTokens = KIMI_K3_MAX_TOKENS;
		}
		// Keep selected OpenRouter model metadata stable until upstream settles.
		if (candidate.provider === "openrouter" && candidate.id === "moonshotai/kimi-k2.5") {
			candidate.cost.input = 0.41;
			candidate.cost.output = 2.06;
			candidate.cost.cacheRead = 0.07;
			candidate.maxTokens = 4096;
		}
		if (candidate.provider === "openrouter" && candidate.id.startsWith("moonshotai/kimi-k2.6")) {
			candidate.compat = {
				...candidate.compat,
				supportsDeveloperRole: false,
				requiresReasoningContentOnAssistantMessages: true,
			};
		}
		if (candidate.provider === "openrouter" && candidate.id === "z-ai/glm-5") {
			candidate.cost.input = 0.6;
			candidate.cost.output = 1.9;
			candidate.cost.cacheRead = 0.119;
		}
	}

	// Add missing gpt models
	const missingOpenAiModels: Model<"openai-responses">[] = [
		{
			id: "gpt-6.1-sol",
			name: "GPT-6.1 Sol",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6.1-sol"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6-astra"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-6-sol",
			name: "GPT-6 Sol",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6-sol"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-6-luna",
			name: "GPT-6 Luna",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6-luna"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-sol"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-terra"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-luna"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5-chat-latest",
			name: "GPT-5 Chat Latest",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		},
	];
	for (const model of missingOpenAiModels) {
		if (!allModels.some((m) => m.provider === model.provider && m.id === model.id)) {
			allModels.push(model);
		}
	}

	const deepseekCompat: OpenAICompletionsCompat = {
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	};
	const deepseekModels: Model<"openai-completions">[] = [
		{
			id: "deepseek-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			thinkingLevelMap: DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP,
			input: ["text", "image"],
			cost: {
				// DeepSeek also offers time-based off-peak rates, which the cost schema cannot represent yet.
				input: 0.3,
				output: 1.2,
				cacheRead: 0.006,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: deepseekCompat,
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			input: ["text"],
			cost: {
				// DeepSeek also offers time-based off-peak rates, which the cost schema cannot represent yet.
				input: 1.32,
				output: 3.96,
				cacheRead: 0.044,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: deepseekCompat,
		},
	];
	allModels.push(...deepseekModels);

	for (const candidate of allModels) {
		if (
			candidate.api === "openai-completions" &&
			candidate.id.includes("deepseek-v4") &&
			!QWEN_TOKEN_PLAN_PROVIDER_IDS.has(candidate.provider)
		) {
			const preservesNativeReasoningEffort = candidate.provider === "openrouter" || candidate.provider === "opencode";
			candidate.compat = {
				...candidate.compat,
				...(preservesNativeReasoningEffort
					? {
							requiresReasoningContentOnAssistantMessages:
								deepseekCompat.requiresReasoningContentOnAssistantMessages,
						}
					: deepseekCompat),
			};
		}
	}

	// OpenAI Codex (ChatGPT OAuth) models
	// NOTE: These are not fetched from models.dev; we keep a small, explicit list to avoid aliases.
	// Older model limits are based on observed server behavior; GPT-5.6 and GPT-6 use Codex's 272k default catalog limit.
	const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
	const CODEX_CONTEXT = 272000;
	const CODEX_GPT_56_CONTEXT = 272000;
	const CODEX_SPARK_CONTEXT = 128000;
	const CODEX_MAX_TOKENS = 128000;
	const codexModels: Model<"openai-codex-responses">[] = [
		{
			id: "gpt-6.1-sol",
			name: "GPT-6.1 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6.1-sol"]),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6-astra"]),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6-sol",
			name: "GPT-6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6-sol"]),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6-luna",
			name: "GPT-6 Luna",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-6-luna"]),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
			contextWindow: CODEX_SPARK_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-luna"]),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-sol"]),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-terra"]),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
	];
	allModels.push(...codexModels);

	allModels.push(...antigravityModels());

	// Add "auto" alias for openrouter/auto
	if (!allModels.some(m => m.provider === "openrouter" && m.id === "auto")) {
		allModels.push({
			id: "auto",
			name: "Auto",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				// we dont know about the costs because OpenRouter auto routes to different models
				// and then charges you for the underlying used model
				input:0,
				output:0,
				cacheRead:0,
				cacheWrite:0,
			},
			contextWindow: 2000000,
			maxTokens: 30000,
		});
	}

	// Add "fusion" alias for openrouter/fusion. OpenRouter exposes Fusion as a
	// router alias/plugin entry point; its model metadata does not advertise
	// tools, but the alias resolves to a concrete model that can invoke caller
	// tools and has the openrouter:fusion server tool auto-injected.
	if (!allModels.some(m => m.provider === "openrouter" && m.id === "openrouter/fusion")) {
		allModels.push({
			id: "openrouter/fusion",
			name: "OpenRouter: Fusion",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				// we dont know about the costs because Fusion routes to multiple models
				// and then charges you for the underlying used models
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 30000,
		});
	}

	// Azure Foundry deploys these with larger context windows than OpenAI's own short-tier defaults.
	// See models-sold-directly-by-azure docs.
	const AZURE_CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
		"gpt-5.4": 1050000,
		"gpt-5.5": 1050000,
		"gpt-5.6-luna": 1050000,
		"gpt-5.6-sol": 1050000,
		"gpt-5.6-terra": 1050000,
	};
	const azureOpenAiModels: Model<Api>[] = allModels
		.filter((model) => model.provider === "openai" && model.api === "openai-responses")
		.map((model) => ({
			...model,
			api: "azure-openai-responses",
			provider: "azure",
			baseUrl: "",
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
			contextWindow: AZURE_CONTEXT_WINDOW_OVERRIDES[model.id] ?? model.contextWindow,
		}));
	allModels.push(...azureOpenAiModels);

	// Azure resells DeepSeek at its own rates. US data zone, checked 2026-09-16.
	// https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/deepseek/
	const AZURE_DEEPSEEK_V4_PRO_COST: ModelCost = { input: 1.925, output: 3.828, cacheRead: 0.165, cacheWrite: 0 };
	// Azure 400s on DeepSeek's `thinking` field and on every prompt cache parameter, discards a
	// `developer` system message unbilled once reasoning_effort is set, and honours mid-convo ones (#9645).
	const azureDeepSeekModels: Model<Api>[] = allModels
		.filter((model) => model.provider === "deepseek" && model.id === "deepseek-v4-pro")
		.map((model) => ({
			...model,
			provider: "azure",
			baseUrl: "",
			cost: AZURE_DEEPSEEK_V4_PRO_COST,
			compat: {
				...(model.compat as OpenAICompletionsCompat),
				supportsDeveloperRole: false,
				supportsMidConvoSystemMessages: true,
				thinkingFormat: "openai",
				supportsLongCacheRetention: false,
			},
		}));
	allModels.push(...azureDeepSeekModels);

	for (const model of allModels) {
		applyOpenAICompletionsCompatMetadata(model);
		applyAnthropicMessagesCompatMetadata(model);
		applyModelsDevReasoningOptionMetadata(model);
		applyThinkingLevelMetadata(model);
		applyStrictToolCompatMetadata(model);
		applyOpenAIGrammarToolCompatMetadata(model);
		applyOpenAIToolSearchMetadata(model);
		applyOpenAICompletionsTranscriptMetadata(model);
		applyOpenAIResponsesTranscriptMetadata(model);
		applyOpenAIExplicitPromptCacheMetadata(model);
		applyInContextCompactionMetadata(model);
		applyPromptCacheMetadata(model);
		applyImageInputMetadata(model);
	}
	applyAnthropicAllowedFallbackModelMetadata(allModels.filter(isAnthropicFallbackMetadataModel));

	// Keep chat and image catalogs separate so one upstream ID can expose both
	// operations with different API implementations.
	type ProviderCatalog = {
		chat: Record<string, Model<Api>>;
		image: Record<string, ImageModel<ImageApi>>;
		classifier: Record<string, ClassifierModel<ClassifierApi>>;
	};
	const providers: Record<string, ProviderCatalog> = {};
	for (const model of allModels) {
		providers[model.provider] ??= { chat: {}, image: {}, classifier: {} };
		// Only add if not already present (models.dev takes priority over OpenRouter).
		providers[model.provider].chat[model.id] ??= { ...model, type: "chat" };
	}
	for (const model of openRouterCatalog.images) {
		applyImageInputMetadata(model);
		providers[model.provider] ??= { chat: {}, image: {}, classifier: {} };
		providers[model.provider].image[model.id] ??= model;
	}
	const classifierModels: ClassifierModel<ClassifierApi>[] = [
		...modelsDevClassifierModels,
		...openRouterCatalog.classifiers,
		...aiGatewayCatalog.classifiers,
		...OPENCODE_CLASSIFIER_MODELS,
		...CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS,
		...OPENAI_CLASSIFIER_MODELS,
	];
	for (const model of classifierModels) {
		providers[model.provider] ??= { chat: {}, image: {}, classifier: {} };
		providers[model.provider].classifier[model.id] ??= model;
	}

	const sortedProviderIds = selectProviderIds(Object.keys(providers).sort());
	if (sortedProviderIds.length === 0) {
		throw new Error("No provider left to generate after filtering the upstream catalogs");
	}
	const generatedProviderIds = new Set(sortedProviderIds);
	// `allModels` and the catalogs above must keep naming every provider, so a
	// flavored run filters here instead of skipping models earlier.
	const catalogProviders = Object.fromEntries(
		Object.entries(providers).filter(([providerId]) => generatedProviderIds.has(providerId)),
	) as Record<string, ProviderCatalog>;
	const jsonChatProviders: Record<string, Record<string, Model<Api>>> = {};
	const jsonImageProviders: Record<string, Record<string, ImageModel<ImageApi>>> = {};
	const jsonClassifierProviders: Record<string, Record<string, ClassifierModel<ClassifierApi>>> = {};
	const jsonAllProviders: Record<string, AnyModel[]> = {};
	for (const providerId of sortedProviderIds) {
		jsonChatProviders[providerId] = Object.fromEntries(
			Object.entries(catalogProviders[providerId].chat).sort(([left], [right]) => left.localeCompare(right)),
		);
		jsonImageProviders[providerId] = Object.fromEntries(
			Object.entries(catalogProviders[providerId].image).sort(([left], [right]) => left.localeCompare(right)),
		);
		jsonClassifierProviders[providerId] = Object.fromEntries(
			Object.entries(catalogProviders[providerId].classifier).sort(([left], [right]) => left.localeCompare(right)),
		);
		jsonAllProviders[providerId] = [
			...Object.values(jsonChatProviders[providerId]),
			...Object.values(jsonImageProviders[providerId]),
			...Object.values(jsonClassifierProviders[providerId]),
		];
	}

	const serializeJson = (value: unknown) => `${JSON.stringify(value, null, generatorOptions.pretty ? 2 : undefined)}\n`;
	const writeJson = (path: string, value: unknown) => writeFileSync(path, serializeJson(value));
	// A data-only run may narrow an existing catalog; the provider set has to be
	// on disk already, because the shards and the aggregator are left alone.
	const generatedDataProviderIds = generatorOptions.dataOnly
		? selectProviderIds(readModelDataProviderIds(packageRoot))
		: sortedProviderIds;
	const missingProviderIds = generatedDataProviderIds.filter((providerId) => !jsonAllProviders[providerId]);
	if (missingProviderIds.length > 0) {
		throw new Error(`Cannot hydrate missing providers: ${missingProviderIds.join(", ")}`);
	}

	// Only the ignored internal data is grouped by API for type derivation.
	const generatedDataProviders: Record<string, Record<string, Record<string, AnyModel>>> = {};
	const modelDataStructure: ModelDataStructure = {};
	for (const providerId of generatedDataProviderIds) {
		const { groups, structure } = groupProviderModelData(providerId, jsonAllProviders[providerId]);
		generatedDataProviders[providerId] = groups;
		modelDataStructure[providerId] = structure;
	}

	const generatedAt = new Date().toISOString();

	if (!generatorOptions.jsonOnly) {
		// Stage and validate all provider values before replacing the current generated data.
		const providersDir = join(packageRoot, "src/providers");
		const dataDir = join(providersDir, "data");
		const stagingRoot = mkdtempSync(join(providersDir, ".model-generation-"));
		const stagedDataDir = join(stagingRoot, "data");
		const previousDataDir = join(stagingRoot, "previous-data");
		let restoreGeneratedCatalog: (() => void) | undefined;
		try {
			mkdirSync(stagedDataDir, { recursive: true });
			const fileContents: Record<string, string> = {};
			for (const providerId of generatedDataProviderIds) {
				const filename = `${providerArtifactName(providerId)}.json`;
				const content = serializeJson(generatedDataProviders[providerId]);
				fileContents[filename] = content;
				writeFileSync(join(stagedDataDir, filename), content);
			}
			writeJson(
				join(stagedDataDir, MODEL_DATA_MANIFEST_FILE),
				createModelDataManifest(modelDataStructure, fileContents, generatedAt),
			);
			validateModelDataDirectory(modelDataStructure, stagedDataDir);

			if (!generatorOptions.dataOnly) {
				const previousShardContents = new Map(
					readdirSync(providersDir)
						.filter((entry) => entry.endsWith(".models.ts"))
						.map((entry) => [entry, readFileSync(join(providersDir, entry), "utf8")] as const),
				);
				// A checkout that never generated has no aggregator to restore, so the
				// rollback removes what this run wrote instead of rewriting it.
				const aggregatorPath = join(packageRoot, "src/models.generated.ts");
				const previousAggregator = existsSync(aggregatorPath) ? readFileSync(aggregatorPath, "utf8") : undefined;
				restoreGeneratedCatalog = () => {
					for (const entry of readdirSync(providersDir)) {
						if (entry.endsWith(".models.ts")) rmSync(join(providersDir, entry));
					}
					for (const [entry, content] of previousShardContents) {
						writeFileSync(join(providersDir, entry), content);
					}
					if (previousAggregator === undefined) rmSync(aggregatorPath, { force: true });
					else writeFileSync(aggregatorPath, previousAggregator);
				};

				const generatedShardFiles = new Set<string>();
				const disabledDir = join(providersDir, "disabled");
				mkdirSync(disabledDir, { recursive: true });
				const generatedStubFiles = new Set<string>();
				for (const providerId of sortedProviderIds) {
					const filename = `${providerArtifactName(providerId)}.models.ts`;
					generatedShardFiles.add(filename);
					writeFileSync(join(providersDir, filename), providerShard(providerId));
					const stubFilename = `${providerArtifactName(providerId)}-models.ts`;
					generatedStubFiles.add(stubFilename);
					writeFileSync(join(disabledDir, stubFilename), providerStub(providerId));
				}
				for (const entry of readdirSync(providersDir)) {
					if (entry.endsWith(".models.ts") && !generatedShardFiles.has(entry)) rmSync(join(providersDir, entry));
				}
				for (const entry of readdirSync(disabledDir)) {
					if (entry.endsWith("-models.ts") && !generatedStubFiles.has(entry)) rmSync(join(disabledDir, entry));
				}

				writeFileSync(aggregatorPath, modelAggregator(sortedProviderIds));
				// The shard set is the catalog set now; keep the config naming it.
				recordFullProviderSet(sortedProviderIds);
				console.log("Generated provider catalogs and src/models.generated.ts");
			}

			const hadPreviousData = existsSync(dataDir);
			if (hadPreviousData) renameSync(dataDir, previousDataDir);
			try {
				renameSync(stagedDataDir, dataDir);
				validateGeneratedModelData(packageRoot);
			} catch (error) {
				rmSync(dataDir, { recursive: true, force: true });
				if (hadPreviousData && existsSync(previousDataDir)) renameSync(previousDataDir, dataDir);
				throw error;
			}
			restoreGeneratedCatalog = undefined;
			console.log(
				generatorOptions.dataOnly
					? "Hydrated JSON model values under src/providers/data/"
					: "Generated JSON model values under src/providers/data/",
			);
		} catch (error) {
			restoreGeneratedCatalog?.();
			throw error;
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	if (generatorOptions.jsonOutputDir) {
		// `models.json` and `providers/{id}.json` retain the legacy keyed chat catalog.
		// The `.all` variants are arrays so the same upstream id can appear once per type.
		const providerOutputDir = join(generatorOptions.jsonOutputDir, "providers");
		rmSync(generatorOptions.jsonOutputDir, { recursive: true, force: true });
		mkdirSync(providerOutputDir, { recursive: true });
		writeJson(join(generatorOptions.jsonOutputDir, "models.json"), jsonChatProviders);
		writeJson(join(generatorOptions.jsonOutputDir, "models.all.json"), jsonAllProviders);
		writeJson(join(generatorOptions.jsonOutputDir, "providers.json"), sortedProviderIds);
		for (const providerId of sortedProviderIds) {
			writeJson(join(providerOutputDir, `${providerId}.json`), jsonChatProviders[providerId]);
			writeJson(join(providerOutputDir, `${providerId}.all.json`), jsonAllProviders[providerId]);
		}
		console.log(`Generated JSON model catalog under ${generatorOptions.jsonOutputDir}`);
	}

	// Print statistics
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter((model) => model.reasoning).length;

	console.log(`\nModel Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(providers)) {
		console.log(
			`  ${provider}: ${Object.keys(models.chat).length} chat models, ${Object.keys(models.image).length} image models, ${Object.keys(models.classifier).length} classifier models`,
		);
	}
}

// Run the generator
generateModels().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
