import { describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	chunks: [] as Array<Record<string, unknown>>,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		constructor(_config: Record<string, unknown>) {}

		models = {
			generateContentStream: async function* () {
				yield* googleGenAiMock.chunks;
			},
		};
	}

	return {
		FinishReason: { STOP: "STOP" },
		FunctionCallingConfigMode: { AUTO: "AUTO", NONE: "NONE", ANY: "ANY", VALIDATED: "VALIDATED" },
		GoogleGenAI,
		ResourceScope: { COLLECTION: "COLLECTION" },
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { stream as streamGoogleGenerativeAi } from "../src/api/google-generative-ai.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { ProviderResponse } from "../src/types.ts";

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

function chunkWith(overrides: Record<string, unknown>): Record<string, unknown> {
	return {
		candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
		...overrides,
	};
}

describe("Google response headers", () => {
	// The Gemini adapters report the response once, from the first stream chunk, so the model an
	// endpoint actually served is observable before the body is consumed.
	it("reports the response headers and the served model once", async () => {
		googleGenAiMock.chunks = [
			chunkWith({
				modelVersion: "gemini-2.5-flash-002",
				sdkHttpResponse: {
					headers: { "x-model": "gemini-2.5-flash-002" },
					responseInternal: { status: 200 },
				},
			}),
			chunkWith({ sdkHttpResponse: { headers: {}, responseInternal: { status: 200 } } }),
		];
		const responses: ProviderResponse[] = [];

		await streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
			apiKey: "test-api-key",
			onResponse: (response) => {
				responses.push(response);
			},
		}).result();

		expect(responses).toEqual([{ status: 200, headers: { "x-model": "gemini-2.5-flash-002" } }]);
	});

	it("stays silent when the SDK exposes no HTTP response", async () => {
		googleGenAiMock.chunks = [chunkWith({})];
		const responses: ProviderResponse[] = [];

		await streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
			apiKey: "test-api-key",
			onResponse: (response) => {
				responses.push(response);
			},
		}).result();

		expect(responses).toEqual([]);
	});
});
