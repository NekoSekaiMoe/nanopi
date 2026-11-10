import { describe, expect, it } from "vitest";
import { buildBaseOptions, clampMaxTokensToContext } from "../src/api/simple-options.ts";
import type { AssistantMessage, Model, Usage } from "../src/types.ts";
import { estimateContextTokens } from "../src/utils/estimate.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(timestamp: number, totalTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "kept" }],
		api: "openai-responses",
		provider: "openai",
		model: "test-model",
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 8_000,
};

describe("context token estimation", () => {
	// Regression for #10497: large new inputs need more room than chars/4 allows.
	it("reserves 3.5 characters per token for new text when limiting output", () => {
		const context = normalizeContext({
			messages: [createAssistant(100, 2_000), { role: "user", content: "x".repeat(3_500), timestamp: 200 }],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 3_000,
			usageTokens: 2_000,
			trailingTokens: 1_000,
			lastUsageIndex: 0,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(2_454);
	});

	it("ignores stale assistant usage after a newer message is inserted before it", () => {
		const context = normalizeContext({
			systemPrompt: "system",
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "x".repeat(4_000), timestamp: 300 },
			],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 1_149,
			usageTokens: 0,
			trailingTokens: 1_149,
			lastUsageIndex: null,
		});
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_582);
	});

	it("reserves output room above the raw estimate so a request does not overshoot the window", () => {
		// The estimate is an average, and OpenRouter adds input and max_tokens up
		// itself. Clamping against the raw figure produced a request whose real
		// input was 12% over the estimate, which OpenRouter rejected as an overflow
		// and the agent then compacted a conversation that still had room.
		const context = normalizeContext({
			messages: [{ role: "user", content: "x".repeat(3_500), timestamp: 200 }],
		});

		expect(estimateContextTokens(context).tokens).toBe(1_000);
		// 10_000 - ceil(1_000 * 1.15) - 4_096
		expect(buildBaseOptions(model, context).maxTokens).toBe(4_754);
	});

	it("sends the clamped max_tokens to OpenRouter instead of omitting it", () => {
		const openRouterModel = {
			...model,
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			api: "openai-completions",
		} as Model<"openai-completions">;
		const context = normalizeContext({
			messages: [{ role: "user", content: "x".repeat(28_000), timestamp: 200 }],
		});

		const unclamped = clampMaxTokensToContext(openRouterModel, context, openRouterModel.maxTokens);
		expect(unclamped).toBeLessThan(openRouterModel.maxTokens);
		// The catalog figure goes out only because clamping lowered it.
		expect(buildBaseOptions(openRouterModel, context).maxTokens).toBe(unclamped);
	});

	it("uses assistant usage again after a response to the inserted context", () => {
		const context = normalizeContext({
			messages: [
				{ role: "user", content: "summary", timestamp: 200 },
				createAssistant(100, 9_500),
				{ role: "user", content: "new prompt", timestamp: 300 },
				createAssistant(400, 2_000),
				{ role: "user", content: "tail", timestamp: 500 },
			],
		});

		expect(estimateContextTokens(context)).toEqual({
			tokens: 2_002,
			usageTokens: 2_000,
			trailingTokens: 2,
			lastUsageIndex: 3,
		});
	});
});
