/**
 * What the summarization code needs to know about tokens and money.
 *
 * `cache-warmer.ts` imports the model runtime and the settings manager to decide when to re-send a
 * request; these two helpers only need a model and some token counts. Summarization reaches them
 * on every compaction, so they live here instead of behind the warming machinery.
 */

import { type Api, calculateCost, type Model, type SimpleStreamOptions, type Usage } from "@nanopi/pi-ai";
import { getProviderEnvValue } from "@nanopi/pi-ai/utils/provider-env";

/** Prompt-cache lifetime in ms for this model and request, or undefined when it is not cacheable. */
export function getPromptCacheTtlMs(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
	const retention =
		options?.cacheRetention ??
		(getProviderEnvValue("NANOPI_CACHE_RETENTION", options?.env) === "long" ? "long" : "short");
	if (retention === "none") return undefined;
	const seconds = model.promptCache?.[retention];
	return seconds === undefined ? undefined : seconds * 1000;
}

/** What a set of token counts costs on this model. */
export function priceTokens(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}
