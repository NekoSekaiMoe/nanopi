import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Regression tests for provider-quirks gaps tracked in shinytale/nanopi#580:
// backends that stream `delta.content` as parts arrays, `function.arguments` as
// objects, and continuation tool-call chunks that omit both `index` and `id`.

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
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

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

const finish = (finish_reason: string) => ({
	id: "chatcmpl-1",
	choices: [{ index: 0, delta: {}, finish_reason }],
});

describe("openai-completions non-standard stream shapes", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("joins delta.content parts arrays into text", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-1",
				choices: [{ index: 0, delta: { content: [{ type: "text", text: "hello " }] } }],
			},
			{
				id: "chatcmpl-1",
				choices: [{ index: 0, delta: { content: [{ type: "text", text: "world" }] } }],
			},
			finish("stop"),
		];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.content).toEqual([{ type: "text", text: "hello world" }]);
	});

	it("merges object-form function.arguments into the tool call", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-1",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read", arguments: { path: "a.ts" } },
								},
							],
						},
					},
				],
			},
			{
				id: "chatcmpl-1",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, function: { arguments: { lines: [1, 2] } } }],
						},
					},
				],
			},
			finish("tool_calls"),
		];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.content).toEqual([
			{
				type: "toolCall",
				id: "call_1",
				name: "read",
				arguments: { path: "a.ts", lines: [1, 2] },
			},
		]);
		expect(message.stopReason).toBe("toolUse");
	});

	it("appends argument-only continuation chunks to the previous tool call", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-1",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } }],
						},
					},
				],
			},
			{
				id: "chatcmpl-1",
				choices: [{ index: 0, delta: { tool_calls: [{ function: { arguments: 'th":"a.ts"}' } }] } }],
			},
			finish("tool_calls"),
		];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.content).toEqual([{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }]);
	});

	it("starts a new tool call when a continuation chunk names a different tool", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-1",
				choices: [
					{
						index: 0,
						delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{}" } }] },
					},
				],
			},
			{
				id: "chatcmpl-1",
				choices: [
					{
						index: 0,
						delta: { tool_calls: [{ function: { name: "grep", arguments: '{"pattern":"x"}' } }] },
					},
				],
			},
			finish("tool_calls"),
		];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.content).toEqual([
			{ type: "toolCall", id: "call_1", name: "read", arguments: {} },
			{ type: "toolCall", id: "", name: "grep", arguments: { pattern: "x" } },
		]);
	});
});
