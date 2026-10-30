import { describe, expect, it } from "vitest";
import { streamSimple as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { streamSimple as streamGoogle } from "../src/api/google-generative-ai.ts";
import { streamSimple as streamCompletions } from "../src/api/openai-completions.ts";
import { streamSimple as streamResponses } from "../src/api/openai-responses.ts";
import { OPENCODE_MODELS } from "../src/providers/opencode.models.ts";
import type { Api, FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 1 }] });

function recorder(): { fetch: FetchFunction; urls: string[] } {
	const urls: string[] = [];
	const fetchImpl: FetchFunction = async (input) => {
		urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : String((input as Request).url));
		return new Response(JSON.stringify({ error: { message: "stop" } }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch: fetchImpl, urls };
}

/** The Google adapter refuses a custom fetch, so route it through the global instead. */
async function withGlobalFetch<T>(fetchImpl: FetchFunction, run: () => Promise<T>): Promise<T> {
	const real = globalThis.fetch;
	globalThis.fetch = fetchImpl as typeof globalThis.fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = real;
	}
}

const calls = {
	"openai-completions": (model: Model<Api>, fetch: FetchFunction) =>
		streamCompletions(model as Model<"openai-completions">, context, {
			apiKey: "k",
			fetch,
			maxRetries: 0,
		}).result(),
	"openai-responses": (model: Model<Api>, fetch: FetchFunction) =>
		streamResponses(model as Model<"openai-responses">, context, { apiKey: "k", fetch, maxRetries: 0 }).result(),
	"anthropic-messages": (model: Model<Api>, fetch: FetchFunction) =>
		streamAnthropic(model as Model<"anthropic-messages">, context, {
			apiKey: "k",
			fetch,
			maxRetries: 0,
		}).result(),
	"google-generative-ai": (model: Model<Api>, fetch: FetchFunction) =>
		withGlobalFetch(fetch, () =>
			streamGoogle(model as Model<"google-generative-ai">, context, { apiKey: "k" }).result(),
		),
} as const;

/**
 * Zen serves only `<family>/v1/...` under `/inference`; `<base>/v1/...` answers
 * 404. The catalog's base URLs therefore have to be the family routes, per
 * wire protocol, and reach the request unchanged.
 */
describe("OpenCode Zen catalog base URLs reach the served route", () => {
	const samples = [
		["glm-5.3-flash-free", "https://opencode.ai/inference/openai/v1/chat/completions"],
		["gpt-5.4", "https://opencode.ai/inference/openai/v1/responses"],
		["claude-sonnet-5-5", "https://opencode.ai/inference/anthropic/v1/messages?beta=true"],
		[
			"gemini-3.5-flash",
			"https://opencode.ai/inference/google/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse",
		],
	] as const;

	for (const [id, expected] of samples) {
		it(`addresses ${id}`, async () => {
			const model = (OPENCODE_MODELS as Record<string, Model<Api>>)[id];
			expect(model).toBeDefined();
			const { fetch, urls } = recorder();
			await calls[model.api as keyof typeof calls](model, fetch);
			expect(urls).toEqual([expected]);
		});
	}
});
