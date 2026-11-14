import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";
import { calculateCost } from "../src/utils/cost.ts";

const GPT_6_AZURE_MODELS = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"] as const;

function usage(input: number): Parameters<typeof calculateCost>[1] {
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("Azure long-context metadata", () => {
	it.each(GPT_6_AZURE_MODELS)("deploys %s with Foundry's 1.05M context window", (modelId) => {
		const azure = getModel("azure", modelId);
		const direct = getModel("openai", modelId);
		expect(azure?.contextWindow).toBe(1050000);
		// Direct OpenAI stays capped at the short-context tier on purpose.
		expect(direct?.contextWindow).toBe(272000);
	});

	it.each(GPT_6_AZURE_MODELS)("keeps %s's long-context pricing tier instead of the short rate", (modelId) => {
		const model = getModel("azure", modelId) as Model<"azure-openai-responses">;
		expect(model.cost.tiers).toEqual([
			{
				inputTokensAbove: 272000,
				input: model.cost.input * 2,
				output: model.cost.output * 1.5,
				cacheRead: model.cost.cacheRead * 2,
				cacheWrite: model.cost.cacheWrite * 2,
			},
		]);

		const short = calculateCost(model, usage(200000));
		expect(short.input).toBeCloseTo((model.cost.input / 1000000) * 200000, 10);

		const long = calculateCost(model, usage(400000));
		expect(long.input).toBeCloseTo(((model.cost.input * 2) / 1000000) * 400000, 10);
	});
});
