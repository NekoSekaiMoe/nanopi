import { describe, expect, it } from "vitest";
import {
	buildProjectId,
	buildRequestId,
	buildSessionId,
	buildUserAgent,
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

describe("pi-fake-opencode headers", () => {
	it("sends the composite CLI user agent", () => {
		expect(buildUserAgent()).toMatch(/^opencode\/\d+\.\d+\.\d+ ai-sdk\/provider-utils\/[\d.]+ runtime\/bun\/[\d.]+$/);
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
		expect(shouldSpoof("opencode", "https://opencode.ai/inference/v1")).toBe(true);
		expect(shouldSpoof("custom", "https://opencode.ai/inference")).toBe(true);
		expect(shouldSpoof("anthropic", "https://api.anthropic.com")).toBe(false);
	});
});

describe("pi-fake-opencode body shaping", () => {
	it("puts the official prompt ahead of the session prompt", () => {
		const body = completionsBody();
		shapeForGateway(body, CONTEXT);
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
		shapeForGateway(body, CONTEXT);
		expect(body.messages.filter((message) => message.role !== "user")).toHaveLength(1);
		expect(body.messages[0].content).toContain("first\n\nsecond");
	});

	it("renames client tools and appends the official set", () => {
		const body = completionsBody();
		shapeForGateway(body, CONTEXT);
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
		shapeForGateway(body, CONTEXT);
		expect(body.max_tokens).toBeUndefined();
		expect(body.max_completion_tokens).toBe(4096);
		expect(body.tool_choice).toBeUndefined();
		expect(body.stream).toBe(true);

		const uncapped = completionsBody();
		shapeForGateway(uncapped, CONTEXT);
		expect(uncapped.max_completion_tokens).toBe(DEFAULT_MAX_COMPLETION_TOKENS);
	});

	it("is idempotent", () => {
		const body = completionsBody();
		shapeForGateway(body, CONTEXT);
		const first = body.messages[0].content as string;
		shapeForGateway(body, CONTEXT);
		expect(body.messages).toHaveLength(2);
		expect(body.messages[0].content).toBe(first);
	});
});
