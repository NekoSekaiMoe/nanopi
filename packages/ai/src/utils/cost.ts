import type { AnyModel, ModelCost, Usage, UsagePricing } from "../types.ts";

/** Deterministic revision for a rate set: any price change yields a different hash. */
function costRevision(provider: string, model: string, rates: ModelCost): string {
	const canonical = JSON.stringify({
		provider,
		model,
		input: rates.input,
		output: rates.output,
		cacheRead: rates.cacheRead,
		cacheWrite: rates.cacheWrite,
		tiers: rates.tiers?.map((tier) => ({
			inputTokensAbove: tier.inputTokensAbove,
			input: tier.input,
			output: tier.output,
			cacheRead: tier.cacheRead,
			cacheWrite: tier.cacheWrite,
		})),
	});
	let hash = 2166136261;
	for (let index = 0; index < canonical.length; index++) {
		hash ^= canonical.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function snapshot(model: AnyModel, rates: ModelCost): UsagePricing {
	return {
		provider: model.provider,
		model: model.id,
		revision: costRevision(model.provider, model.id, rates),
		// Deep copy: later edits to the catalog object (for example a user upsert)
		// must not rewrite the rate snapshot on a stored usage.
		rates: structuredClone(rates),
	};
}

/** What a set of token counts costs on a model. Mutates `usage.cost` and returns it. */
export function calculateCost(model: AnyModel, usage: Usage): Usage["cost"] {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates: ModelCost = model.cost;
	let matchedThreshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
			rates = tier;
			matchedThreshold = tier.inputTokensAbove;
		}
	}

	// Anthropic charges 2x base input for 1h cache writes.
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.input = (rates.input / 1000000) * usage.input;
	usage.cost.output = (rates.output / 1000000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	usage.pricing = snapshot(model, rates);
	return usage.cost;
}
