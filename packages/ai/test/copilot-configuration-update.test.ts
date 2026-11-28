import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage } from "../src/types.ts";

type Item = { type?: string; reasoning?: { effort?: string } };

interface Payload {
	reasoning?: { effort?: string };
	input?: Item[];
}

afterEach(() => vi.restoreAllMocks());

function previousAssistant(level: "low" | "high"): AssistantMessage {
	const model = getModel("github-copilot", "gpt-6-sol");
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "text", text: "ok", textSignature: JSON.stringify({ id: "msg_prev" }) }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		providerThinkingLevel: level,
	};
}

async function capture(
	effort: "low" | "high",
	previous?: AssistantMessage,
): Promise<{ payload: Payload; message: AssistantMessage }> {
	let payload: Payload | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new Error("payload captured");
	});
	const stream = streamOpenAIResponses(
		getModel("github-copilot", "gpt-6-sol"),
		normalizeContext({
			systemPrompt: "sys",
			messages: [...(previous ? [previous] : []), { role: "user", content: "hi", timestamp: Date.now() }],
		}),
		{
			apiKey: "sk-test-key",
			reasoningEffort: effort,
			onPayload: (value) => {
				payload = value as Payload;
			},
		},
	);
	const message = await stream.result();
	if (!payload) throw new Error("Expected payload capture");
	return { payload, message };
}

describe("Copilot configuration_update effort", () => {
	it("sends effort updates in input and pins reasoning.effort", async () => {
		const first = await capture("low");
		expect(first.payload.reasoning?.effort).toBe("medium");
		expect(first.payload.input?.at(-1)).toMatchObject({ type: "configuration_update", reasoning: { effort: "low" } });
		expect(first.message.providerThinkingLevel).toBe("low");

		const second = await capture("high", previousAssistant("low"));
		expect(second.payload.reasoning?.effort).toBe("medium");
		expect(
			second.payload.input
				?.filter((item) => item.type === "configuration_update")
				.map((item) => item.reasoning?.effort),
		).toEqual(["low", "high"]);
		expect(second.message.providerThinkingLevel).toBe("high");
	});
});
