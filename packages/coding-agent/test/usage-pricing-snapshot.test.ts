import type { Usage } from "@nanopi/pi-ai";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-store.ts";
import { combineUsage, getUsageCostBreakdown } from "../src/core/usage-totals.ts";

function usage(pricing?: Usage["pricing"]): Usage {
	return {
		input: 100,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 120,
		cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		...(pricing ? { pricing } : {}),
	};
}

const snapshot: Usage["pricing"] = {
	provider: "anthropic",
	model: "claude-sonnet",
	revision: "abc123",
	rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

describe("usage pricing snapshot in the ledger", () => {
	it("keeps the first snapshot when combining two usages", () => {
		const combined = combineUsage(usage(snapshot), usage());
		expect(combined.pricing).toEqual(snapshot);
		expect(combined.input).toBe(200);
	});

	it("keeps recorded cost intact in the session cost breakdown", () => {
		const entries = [
			{
				type: "message",
				id: "1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude-sonnet",
					usage: usage(snapshot),
				},
			},
		] as unknown as SessionEntry[];
		const breakdown = getUsageCostBreakdown(entries);
		expect(breakdown).toHaveLength(1);
		expect(breakdown[0]?.cost).toBeCloseTo(0.003);
	});
});
