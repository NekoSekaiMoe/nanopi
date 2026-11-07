import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions, streamSimple } from "../src/api/openai-completions.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

interface CapturedParams {
	store?: boolean;
	max_tokens?: number;
	max_completion_tokens?: number;
	reasoning_effort?: string;
	stream_options?: { include_usage?: boolean };
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedParams | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedParams) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

function createModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	return {
		...(baseModel as Omit<Model<"openai-completions">, "api">),
		api: "openai-completions",
		...overrides,
	};
}

function context() {
	return normalizeContext({
		systemPrompt: "sys",
		messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
	});
}

async function captureRequest(
	model: Model<"openai-completions">,
	options?: { maxTokens?: number; reasoning?: "high" },
) {
	await streamSimple(model, context(), { apiKey: "test-key", ...options }).result();
	return mockState.lastParams;
}

describe("openai-completions self-hosted endpoint defaults", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	// A vLLM / SGLang / Ollama / LM Studio server on loopback does not implement
	// OpenAI's store, reasoning_effort or max_completion_tokens fields, and some
	// versions reject them with HTTP 400.
	it.each([
		"http://localhost:11434/v1",
		"http://127.0.0.1:8000/v1",
		"http://[::1]:8080/v1",
		"http://192.168.1.10:1234/v1",
		"http://10.0.0.5:8000/v1",
		"http://172.20.1.2:8000/v1",
		"http://box.local:8000/v1",
	] as const)("sends no OpenAI-only fields to %s", async (baseUrl) => {
		const payload = await captureRequest(createModel({ provider: "custom", baseUrl, reasoning: true }), {
			reasoning: "high",
		});

		expect(payload?.store).toBeUndefined();
		expect(payload?.reasoning_effort).toBeUndefined();
		expect(payload?.max_completion_tokens).toBeUndefined();
		expect(payload?.max_tokens).toBe(16384);
	});

	it("keeps the OpenAI fields for a public custom endpoint", async () => {
		const payload = await captureRequest(
			createModel({ provider: "custom", baseUrl: "https://api.example.com/v1", reasoning: true }),
			{ reasoning: "high" },
		);

		expect(payload?.store).toBe(false);
		expect(payload?.reasoning_effort).toBe("high");
		expect(payload?.max_completion_tokens).toBe(16384);
	});

	it("still sends stream_options to a self-hosted endpoint", async () => {
		const payload = await captureRequest(createModel({ provider: "custom", baseUrl: "http://localhost:8000/v1" }));

		expect(payload?.stream_options).toEqual({ include_usage: true });
	});
});

describe("openai-completions OpenRouter output cap", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	// OpenRouter filters upstreams by max output, so the catalog figure would drop
	// the backup providers in provider.order. https://github.com/shinytale/nanopi/issues/580
	it("omits max output tokens when the caller set no cap", async () => {
		const model = createModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
		const payload = await captureRequest(model);

		expect(payload?.max_completion_tokens).toBeUndefined();
		expect(payload?.max_tokens).toBeUndefined();
	});

	it("sends an explicit caller cap unchanged", async () => {
		const model = createModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
		const payload = await captureRequest(model, { maxTokens: 1024 });

		expect(payload?.max_completion_tokens).toBe(1024);
	});

	it("still sends the catalog cap for non-OpenRouter endpoints", async () => {
		const payload = await captureRequest(createModel());

		expect(payload?.max_completion_tokens).toBe(16384);
	});

	it("keeps the thinking budget inside the model cap when the cap is omitted", async () => {
		const model = createModel({
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			maxTokens: 2048,
			compat: { thinkingTokenBudgetField: "thinking_budget" } as Model<"openai-completions">["compat"],
		});
		await streamOpenAICompletions(model, context(), { apiKey: "test-key", reasoningEffort: "high" }).result();

		const payload = mockState.lastParams as CapturedParams & { thinking_budget?: number };
		expect(payload.max_completion_tokens).toBeUndefined();
		expect(payload.thinking_budget).toBe(1024);
	});
});
