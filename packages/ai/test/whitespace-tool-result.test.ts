import { describe, expect, it } from "vitest";
import { convertMessages as convertGoogle } from "../src/api/google-shared.ts";
import { convertMessages as convertCompletions } from "../src/api/openai-completions.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Model, OpenAICompletionsCompat, ToolResultMessage, Usage } from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const completionsCompat: Omit<Required<OpenAICompletionsCompat>, "thinkingTokenBudgetField" | "vllmPriority"> & {
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
} = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsThinkingTokenBudget: false,
	thinkingTokenBudgetField: undefined,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	supportsInContextCompaction: false,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
};

function buildWhitespaceToolResult(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "\r\n" }],
		isError: false,
		timestamp,
	};
}

function buildContext(model: { api: string; provider: string; id: string }) {
	const now = Date.now();
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "printf '\\r\\n'" } }],
		api: model.api as AssistantMessage["api"],
		provider: model.provider as AssistantMessage["provider"],
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: now,
	};
	return normalizeContext({
		messages: [
			{ role: "user", content: "Run the command", timestamp: now - 1 },
			assistant,
			buildWhitespaceToolResult("tool-1", now + 1),
		],
	});
}

// Ported from earendil-works/pi#8720: a tool result whose text is only whitespace
// (a bare newline from bash) made OpenAI Completions, OpenAI Responses, and Google
// reject the request.
describe("whitespace-only tool results", () => {
	it("OpenAI Completions sends the no-output placeholder", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text"],
		};

		const messages = convertCompletions(model, buildContext(model), completionsCompat);
		const toolMessage = messages.find((message) => message.role === "tool") as
			| { role: "tool"; content: string }
			| undefined;

		expect(toolMessage?.content).toBe("(no tool output)");
	});

	it("OpenAI Responses sends the no-output placeholder", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const input = convertResponsesMessages(model, buildContext(model), new Set(["openai"]));
		const functionCallOutput = input.find((item) => item.type === "function_call_output") as
			| { type: "function_call_output"; output: string }
			| undefined;

		expect(functionCallOutput?.output).toBe("(no tool output)");
	});

	it("Google sends an empty function response instead of whitespace", () => {
		const model: Model<"google-generative-ai"> = {
			id: "gemini-3-pro-preview",
			name: "Gemini 3 Pro Preview",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		};

		const contents = convertGoogle(model, buildContext(model));
		const functionResponse = contents
			.flatMap((content) => content.parts ?? [])
			.find((part) => "functionResponse" in part) as
			| { functionResponse: { response: { output?: string; error?: string } } }
			| undefined;

		expect(functionResponse?.functionResponse.response.output).toBe("");
	});
});
