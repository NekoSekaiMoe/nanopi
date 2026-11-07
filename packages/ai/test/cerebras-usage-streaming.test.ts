import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

interface CapturedParams {
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
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: { content: "ok" } }],
							};
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
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

function cerebrasModel(): Model<"openai-completions"> {
	return {
		id: "gpt-oss-120b",
		name: "GPT OSS 120B",
		api: "openai-completions",
		provider: "cerebras",
		baseUrl: "https://api.cerebras.ai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 4096,
	};
}

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

describe("Cerebras stream usage compat (#580)", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("omits stream_options.include_usage when compat is not set", async () => {
		await streamOpenAICompletions(cerebrasModel(), context, { apiKey: "test" }).result();

		expect(mockState.lastParams?.stream_options).toBeUndefined();
	});

	it("still sends include_usage for standard OpenAI-compatible endpoints", async () => {
		const openaiModel = { ...cerebrasModel(), provider: "openai" as const, baseUrl: "https://api.openai.com/v1" };
		await streamOpenAICompletions(openaiModel, context, { apiKey: "test" }).result();

		expect(mockState.lastParams?.stream_options).toEqual({ include_usage: true });
	});
});
