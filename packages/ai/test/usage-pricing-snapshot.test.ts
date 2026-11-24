import { describe, expect, it } from "vitest";
import type { Model, Usage } from "../src/types.ts";
import { calculateCost } from "../src/utils/cost.ts";

function model(
	cost: Model<"anthropic-messages">["cost"],
	id = "claude-sonnet",
	provider = "anthropic",
): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://api.anthropic.com",
		input: ["text"],
		cost,
		reasoning: false,
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

function usage(): Usage {
	return {
		input: 100,
		output: 50,
		cacheRead: 20,
		cacheWrite: 10,
		totalTokens: 180,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("usage pricing snapshot", () => {
	it("records the provider, model, rates, and a stable revision", () => {
		const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
		const first = usage();
		const second = usage();
		calculateCost(model(cost), first);
		calculateCost(model(cost), second);
		expect(first.pricing).toBeDefined();
		expect(first.pricing?.provider).toBe("anthropic");
		expect(first.pricing?.model).toBe("claude-sonnet");
		expect(first.pricing?.rates).toEqual(cost);
		expect(first.pricing?.revision).toBe(second.pricing?.revision);
	});

	it("changes the revision when any rate changes", () => {
		const base = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
		const first = usage();
		const changed = usage();
		calculateCost(model(base), first);
		calculateCost(model({ ...base, output: 16 }), changed);
		expect(changed.pricing?.revision).not.toBe(first.pricing?.revision);
	});

	it("snapshots the full rate table including tiers", () => {
		const base = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
		const tier = { inputTokensAbove: 200000, input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 };
		const fullCost = { ...base, tiers: [tier] };
		const result = usage();
		calculateCost(model(fullCost), result);
		expect(result.pricing?.rates).toEqual(fullCost);
	});

	it("does not mutate the snapshot when the catalog rates are edited later", () => {
		const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
		const result = usage();
		calculateCost(model(cost), result);
		cost.input = 100;
		expect(result.pricing?.rates.input).toBe(3);
	});
});
