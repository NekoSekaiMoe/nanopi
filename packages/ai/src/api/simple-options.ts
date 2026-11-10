import { clampThinkingLevel } from "../models.ts";
import type {
	Api,
	Model,
	ModelThinkingLevel,
	SamplingParams,
	SimpleStreamOptions,
	StreamOptions,
	ThinkingBudgets,
	ThinkingLevel,
	TranscriptContext,
} from "../types.ts";
import { estimateContextTokensForRequest } from "../utils/estimate.ts";
import { isOpenRouterModel } from "../utils/openrouter-cost.ts";

const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;

export function clampMaxTokensToContext(model: Model<Api>, context: TranscriptContext, maxTokens: number): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	const available = model.contextWindow - estimateContextTokensForRequest(context) - CONTEXT_SAFETY_TOKENS;
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

export function resolveSamplingParams(
	model: Model<Api>,
	thinkingLevel: ModelThinkingLevel,
	requestParams?: SamplingParams,
): SamplingParams | undefined {
	const effectiveThinkingLevel = clampThinkingLevel(model, thinkingLevel);
	const thinkingLevelParams = model.samplingParamsByThinkingLevel?.[effectiveThinkingLevel];
	return model.samplingParams || thinkingLevelParams || requestParams
		? { ...model.samplingParams, ...thinkingLevelParams, ...requestParams }
		: undefined;
}

/**
 * OpenRouter drops any upstream whose max output is below the request's cap, so
 * sending the catalog figure defeats a configured `provider.order` fallback chain.
 *
 * Only an explicit caller cap goes out, unless the catalog figure had to be
 * clamped to fit the context window. OpenRouter counts input plus max_tokens
 * against the context length, so omitting the clamped figure turned a request
 * that fits into an overflow, and the agent then compacted a conversation that
 * still had room.
 *
 * The catalog value still applies when the provider needs one: Anthropic requires
 * max_tokens, and the completions adapter falls back to the catalog figure for the
 * thinking-budget ceiling.
 */
function resolveBaseMaxTokens(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): number | undefined {
	const requested = options?.maxTokens ?? model.maxTokens;
	const clamped = clampMaxTokensToContext(model, context, requested);
	if (options?.maxTokens !== undefined) return clamped;
	if (!isOpenRouterModel(model)) return clamped;
	// OpenRouter filters upstreams by output cap, so the catalog figure would drop the
	// backup providers in provider.order (nanopi#580). The capped figure still goes
	// out once clamping lowered it: OpenRouter counts input plus max_tokens against
	// the context length, so omitting it turned a request that fits into an overflow
	// and the agent compacted a conversation that still had room.
	return clamped >= requested ? undefined : clamped;
}

export function buildBaseOptions(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
	apiKey?: string,
): StreamOptions {
	const samplingParams = resolveSamplingParams(model, options?.reasoning ?? "off", options?.samplingParams);
	return {
		temperature: options?.temperature,
		samplingParams,
		maxTokens: resolveBaseMaxTokens(model, context, options),
		signal: options?.signal,
		apiKey: apiKey || options?.apiKey,
		fetch: options?.fetch,
		transport: options?.transport,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		onProviderStreamEvent: options?.onProviderStreamEvent,
		timeoutMs: options?.timeoutMs,
		websocketConnectTimeoutMs: options?.websocketConnectTimeoutMs,
		maxRetries: options?.maxRetries,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		env: options?.env,
	};
}

/** Tokens always left for the answer when a thinking budget shares the response ceiling. */
export const MIN_ANSWER_TOKENS = 1024;

export const DEFAULT_THINKING_BUDGETS: ThinkingBudgets = {
	minimal: 1024,
	low: 4096,
	medium: 8192,
	high: 16384,
	xhigh: 24576,
	max: 32768,
};

export function thinkingBudgetForLevel(reasoningLevel: ThinkingLevel, customBudgets?: ThinkingBudgets): number {
	const budgets = { ...DEFAULT_THINKING_BUDGETS, ...customBudgets };
	return budgets[reasoningLevel]!;
}

/** Cap a thinking budget so at least MIN_ANSWER_TOKENS remain under a shared response ceiling. */
export function clampThinkingBudgetToAnswerRoom(thinkingBudget: number, ceiling: number): number {
	return Math.min(thinkingBudget, Math.max(0, ceiling - MIN_ANSWER_TOKENS));
}

export function adjustMaxTokensForThinking(
	// Undefined means no explicit caller cap. Use the model cap and fit thinking inside it.
	baseMaxTokens: number | undefined,
	modelMaxTokens: number,
	reasoningLevel: ThinkingLevel,
	customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
	let thinkingBudget = thinkingBudgetForLevel(reasoningLevel, customBudgets);
	const maxTokens =
		baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

	if (maxTokens <= thinkingBudget) {
		thinkingBudget = clampThinkingBudgetToAnswerRoom(thinkingBudget, maxTokens);
	}

	return { maxTokens, thinkingBudget };
}
