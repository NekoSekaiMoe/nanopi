import { describe, expect, it } from "vitest";
import {
	buildProjectId,
	buildRequestId,
	buildSessionId,
	buildUserAgent,
	laneForBaseUrl,
	shouldSpoof,
	userTurnFingerprint,
} from "../src/extras/pi-fake-opencode/src/headers.ts";
import {
	DEFAULT_MAX_COMPLETION_TOKENS,
	SYSTEM_PROMPT_SEPARATOR,
	shapeForGateway,
	wireToolName,
} from "../src/extras/pi-fake-opencode/src/payload.ts";

const CONTEXT = { modelId: "glm-5.3-flash-free", cwd: "/workspace" };
const V1_CONTEXT = { ...CONTEXT, lane: "v1" as const };

/** Loose shape: the body is rewritten in place, so fields come and go. */
type LooseBody = Record<string, any> & {
	messages: Array<{ role: string; content: any }>;
	tools: Array<{ type?: string; function: { name: string; [key: string]: unknown } }>;
};

function completionsBody(overrides: Record<string, unknown> = {}): LooseBody {
	return {
		model: "glm-5.3-flash-free",
		stream: true,
		messages: [
			{ role: "system", content: "nanopi system prompt" },
			{ role: "user", content: [{ type: "text", text: "hello" }] },
		],
		tools: [
			{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } },
			{ type: "function", function: { name: "bash", description: "Run", parameters: { type: "object" } } },
		],
		...overrides,
	};
}

function anthropicBody(overrides: Record<string, unknown> = {}): Record<string, any> {
	return {
		model: "claude-sonnet-4-6",
		max_tokens: 4096,
		system: [{ type: "text", text: "nanopi system prompt" }],
		messages: [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
			},
			{ role: "user", content: [{ type: "text", text: "hello" }] },
		],
		tools: [{ name: "bash", description: "Run", input_schema: { type: "object" } }],
		tool_choice: { type: "tool", name: "bash" },
		...overrides,
	};
}

function responsesBody(overrides: Record<string, unknown> = {}): Record<string, any> {
	return {
		model: "gpt-5.4",
		instructions: "nanopi system prompt",
		input: [
			{ type: "function_call", call_id: "c1", name: "bash", arguments: "{}" },
			{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
		],
		tools: [{ type: "function", name: "bash", description: "Run", parameters: { type: "object" } }],
		...overrides,
	};
}

function googleBody(overrides: Record<string, unknown> = {}): Record<string, any> {
	return {
		model: "gemini-3.5-flash",
		contents: [{ role: "user", parts: [{ text: "hello" }] }],
		config: {
			systemInstruction: "nanopi system prompt",
			tools: [{ functionDeclarations: [{ name: "bash", description: "Run", parametersJsonSchema: {} }] }],
		},
		...overrides,
	};
}

describe("pi-fake-opencode headers", () => {
	it("sends the composite CLI user agent per lane", () => {
		expect(buildUserAgent("v2")).toMatch(/^opencode\/latest\/\d+\.\d+\.\d+\/cli$/);
		expect(buildUserAgent("v1")).toMatch(
			/^opencode\/\d+\.\d+\.\d+ ai-sdk\/provider-utils\/[\d.]+ runtime\/bun\/[\d.]+$/,
		);
	});

	it("mints a descending session id, stable per session", () => {
		const first = buildSessionId("session-a");
		expect(first).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		// Descending ids invert the timestamp, so the low 12 bits end in fff - counter.
		expect(first.slice(4 + 9, 4 + 12)).toMatch(/^f[c-f][0-9a-f]$/);
		expect(buildSessionId("session-a")).toBe(first);
		expect(buildSessionId("session-b")).not.toBe(first);
	});

	it("reuses one request id per user turn and mints a new one for the next", () => {
		const first = buildRequestId("session-a", "1:abc");
		expect(first).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		expect(buildRequestId("session-a", "1:abc")).toBe(first);
		expect(buildRequestId("session-a", "2:def")).not.toBe(first);
	});

	it("fingerprints the current user turn, ignoring tool results", () => {
		const one = userTurnFingerprint({ messages: [{ role: "user", content: "hi" }] });
		const toolStep = userTurnFingerprint({
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "calling" },
				{ role: "tool", content: "result" },
			],
		});
		const next = userTurnFingerprint({
			messages: [
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "calling" },
				{ role: "tool", content: "result" },
				{ role: "user", content: "again" },
			],
		});
		expect(one).not.toBe("");
		expect(toolStep).toBe(one);
		expect(next).not.toBe(one);
	});

	it("sends a git-commit-shaped project id", () => {
		expect(buildProjectId("/workspace")).toMatch(/^[0-9a-f]{40}$/);
		expect(buildProjectId("/workspace")).toBe(buildProjectId("/workspace"));
	});

	it("scopes spoofing to OpenCode traffic", () => {
		expect(shouldSpoof("opencode", "https://opencode.ai/inference")).toBe(true);
		expect(shouldSpoof("custom", "https://opencode.ai/inference")).toBe(true);
		expect(shouldSpoof("anthropic", "https://api.anthropic.com")).toBe(false);
	});

	it("splits lanes like the gate does", () => {
		expect(laneForBaseUrl("https://opencode.ai/inference")).toBe("v2");
		// Zen routes its 2.x models under per-family paths.
		expect(laneForBaseUrl("https://opencode.ai/inference/openai/v1")).toBe("v2");
		expect(laneForBaseUrl("https://opencode.ai/inference/anthropic/v1")).toBe("v2");
		expect(laneForBaseUrl("https://opencode.ai/inference/google/v1beta")).toBe("v2");
		expect(laneForBaseUrl("https://opencode.ai/inference/go/openai/v1")).toBe("v2");
		expect(laneForBaseUrl("https://opencode.ai/zen/go")).toBe("v2");
		expect(laneForBaseUrl("https://opencode.ai/zen")).toBe("v1");
		expect(laneForBaseUrl("https://opencode.ai/zen/")).toBe("v1");
		expect(laneForBaseUrl("https://opencode.ai/zen/v1")).toBe("v1");
		expect(laneForBaseUrl(undefined)).toBe("v2");
	});
});

describe("pi-fake-opencode body shaping", () => {
	it("puts the official prompt ahead of the session prompt", () => {
		const body = completionsBody();
		shapeForGateway(body, "openai-completions", CONTEXT);
		const system = body.messages[0].content as string;
		expect(body.messages[0].role).toBe("system");
		expect(system.startsWith("You are opencode, an interactive CLI tool")).toBe(true);
		expect(system).toContain(SYSTEM_PROMPT_SEPARATOR);
		expect(system.endsWith("nanopi system prompt")).toBe(true);
		expect(system).toContain(CONTEXT.modelId);
	});

	it("folds every system message into the leading one", () => {
		const body = completionsBody({
			messages: [
				{ role: "system", content: "first" },
				{ role: "developer", content: "second" },
				{ role: "user", content: "hello" },
			],
		});
		shapeForGateway(body, "openai-completions", CONTEXT);
		expect(body.messages.filter((message) => message.role !== "user")).toHaveLength(1);
		expect(body.messages[0].content).toContain("first\n\nsecond");
	});

	it("renames client tools and appends the official set", () => {
		const body = completionsBody();
		shapeForGateway(body, "openai-completions", CONTEXT);
		const names = body.tools.map((tool) => tool.function.name);
		expect(names).toContain(wireToolName("read"));
		expect(names).toContain(wireToolName("bash"));
		// The client's own names travel only as opaque wire names; `read` and `patch`
		// below are the official entries.
		expect(names.filter((name) => name === "read")).toHaveLength(1);
		expect(names.slice(-13)).toEqual([
			"edit",
			"execute",
			"glob",
			"grep",
			"question",
			"read",
			"shell",
			"skill",
			"subagent",
			"webfetch",
			"websearch",
			"write",
			"patch",
		]);
	});

	it("uses the CLI's field names", () => {
		const body = completionsBody({ max_tokens: 4096, tool_choice: "auto", stream: false });
		shapeForGateway(body, "openai-completions", CONTEXT);
		expect(body.max_tokens).toBeUndefined();
		expect(body.max_completion_tokens).toBe(4096);
		expect(body.tool_choice).toBe("auto");
		expect(body.stream).toBe(true);
		expect(body.stream_options).toEqual({ include_usage: true });

		const uncapped = completionsBody();
		shapeForGateway(uncapped, "openai-completions", CONTEXT);
		expect(uncapped.max_completion_tokens).toBe(DEFAULT_MAX_COMPLETION_TOKENS);
	});

	it("is idempotent", () => {
		const body = completionsBody();
		shapeForGateway(body, "openai-completions", CONTEXT);
		const first = body.messages[0].content as string;
		shapeForGateway(body, "openai-completions", CONTEXT);
		expect(body.messages).toHaveLength(2);
		expect(body.messages[0].content).toBe(first);
	});

	it("sends the 1.x tool names on the v1 lane", () => {
		const body = completionsBody();
		shapeForGateway(body, "openai-completions", V1_CONTEXT);
		const names = body.tools.map((tool) => tool.function.name);
		expect(names).toContain("bash");
		expect(names).not.toContain("shell");
		expect((body.messages[0].content as string).includes("bash")).toBe(true);
	});

	it("shapes an Anthropic body: system, tools and tool references", () => {
		const body = anthropicBody();
		const { toolRenames } = shapeForGateway(body, "anthropic-messages", CONTEXT);
		expect(body.stream).toBe(true);
		// The caller's block list stays a list; the prompt heads it.
		expect(Array.isArray(body.system)).toBe(true);
		expect(body.system[0].text.startsWith("You are opencode, an interactive CLI tool")).toBe(true);
		expect(body.system[0].text.endsWith("nanopi system prompt")).toBe(true);
		const names = body.tools.map((tool: { name: string }) => tool.name);
		expect(names).toContain("read");
		expect(names).toContain("shell");
		expect(names).not.toContain("bash");
		const wire = toolRenames.get(wireToolName("bash"));
		expect(wire).toBe("bash");
		// History and tool_choice follow the same rename.
		expect(body.tools[0].name).toBe(wireToolName("bash"));
		expect(body.messages[0].content[0].name).toBe(wireToolName("bash"));
		expect(body.tool_choice.name).toBe(wireToolName("bash"));
		// Anthropic tool definitions carry input_schema, not parameters.
		expect(body.tools.at(-1).input_schema).toBeDefined();
	});

	it("shapes a Responses body: instructions, tools and call references", () => {
		const body = responsesBody();
		shapeForGateway(body, "openai-responses", CONTEXT);
		expect(body.stream).toBe(true);
		expect(body.instructions.startsWith("You are opencode, an interactive CLI tool")).toBe(true);
		expect(body.instructions.endsWith("nanopi system prompt")).toBe(true);
		expect(body.tools[0].name).toBe(wireToolName("bash"));
		expect(body.input[0].name).toBe(wireToolName("bash"));
		const names = body.tools.map((tool: { name: string }) => tool.name);
		expect(names).toContain("shell");
	});

	it("shapes a Google body: systemInstruction and function declarations", () => {
		const body = googleBody();
		shapeForGateway(body, "google-generative-ai", CONTEXT);
		expect(body.config.systemInstruction.startsWith("You are opencode, an interactive CLI tool")).toBe(true);
		expect(body.config.systemInstruction.endsWith("nanopi system prompt")).toBe(true);
		const declarations = body.config.tools[0].functionDeclarations;
		expect(declarations[0].name).toBe(wireToolName("bash"));
		expect(declarations.map((entry: { name: string }) => entry.name)).toContain("shell");
	});

	it("leaves an already-official Anthropic system alone", () => {
		const body = anthropicBody();
		shapeForGateway(body, "anthropic-messages", CONTEXT);
		const first = body.system[0].text;
		shapeForGateway(body, "anthropic-messages", CONTEXT);
		expect(body.system[0].text).toBe(first);
	});
});
