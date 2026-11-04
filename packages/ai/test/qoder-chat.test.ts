import { afterEach, describe, expect, it, vi } from "vitest";
import { parseQoderStreamFrame } from "../src/qoder/chat.ts";
import { qoderEndpoints } from "../src/qoder/endpoints.ts";

const neverAbortedSignal = new AbortController().signal;

function sseStream(frames: readonly unknown[], status = 200): Response {
	const body = frames.map((frame) => `data:${JSON.stringify(frame)}\n\n`).join("");
	return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

/** One upstream frame: a JSON chunk wrapped in the agent's envelope. */
function frame(chunk: unknown, statusCodeValue = 200): unknown {
	return { headers: {}, body: JSON.stringify(chunk), statusCodeValue };
}

function model(overrides: Record<string, unknown> = {}) {
	return {
		id: "dmodel",
		name: "DeepSeek-V4-Pro",
		api: "qoder" as const,
		provider: "qoder",
		baseUrl: qoderEndpoints("global").chatUrl,
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32768,
		...overrides,
	};
}

const credentialOptions = {
	apiKey: "dt-abc",
	env: { QODER_ACCOUNT_ID: "u-1", QODER_ACCOUNT_NAME: "Ada", QODER_ACCOUNT_USER_TYPE: "personal_standard" },
	signal: neverAbortedSignal,
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Qoder stream frames", () => {
	it("reads content, reasoning and tool calls out of the envelope", () => {
		expect(
			parseQoderStreamFrame(
				JSON.stringify(
					frame({
						choices: [
							{
								delta: {
									content: "hi",
									reasoning_content: "thinking",
									tool_calls: [{ index: 0, function: { name: "read", arguments: "{}" } }],
								},
								finish_reason: "tool_calls",
							},
						],
						usage: { prompt_tokens: 10, completion_tokens: 3 },
					}),
				),
			),
		).toMatchObject({
			content: "hi",
			reasoning: "thinking",
			finishReason: "tool_calls",
			inputTokens: 10,
			outputTokens: 3,
		});
	});

	it("reports an envelope status and an in-band business code as errors", () => {
		expect(parseQoderStreamFrame(JSON.stringify(frame({ error: "boom" }, 418))).error).toMatch(/HTTP 418/);
		expect(parseQoderStreamFrame(JSON.stringify(frame({ code: "115", message: "no quota" }))).error).toBe(
			"Qoder error 115: no quota",
		);
	});

	it("ignores frames it cannot read", () => {
		expect(parseQoderStreamFrame("not json")).toEqual({});
		expect(parseQoderStreamFrame(JSON.stringify({ headers: {} }))).toEqual({});
	});
});

describe("Qoder chat adapter", () => {
	it("sends a signed agent envelope and converts the stream", async () => {
		const { stream } = await import("../src/api/qoder.ts");
		const url = qoderEndpoints("global").chatUrl;
		let request: { url: string; init: RequestInit } | undefined;
		vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
			request = { url: String(input), init: init ?? {} };
			return sseStream([
				frame({ choices: [{ delta: { role: "assistant", content: "Hello" } }] }),
				frame({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] }),
			]);
		});

		const result = await stream(
			model(),
			{
				messages: [{ role: "user", content: "hi", timestamp: 0 }],
			} as never,
			credentialOptions,
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
		const body = JSON.parse(String(request?.init.body));
		expect(request?.url).toBe(url);
		expect(body.model_config).toMatchObject({ key: "dmodel" });
		expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
		// Signed, not a bearer device token: the upstream rejects a plain token here.
		const headers = new Headers(request?.init.headers);
		expect(headers.get("authorization")?.startsWith("Bearer COSY.")).toBe(true);
		expect(headers.get("cosy-user")).toBe("u-1");
	});

	it("turns streamed tool calls into toolUse", async () => {
		const { stream } = await import("../src/api/qoder.ts");
		vi.stubGlobal("fetch", async () =>
			sseStream([
				frame({
					choices: [
						{
							delta: {
								tool_calls: [{ index: 0, id: "call-1", function: { name: "read", arguments: '{"path":' } }],
							},
						},
					],
				}),
				frame({
					choices: [
						{
							delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp/a"}' } }] },
							finish_reason: "tool_calls",
						},
					],
				}),
			]),
		);

		const result = await stream(
			model(),
			{ messages: [{ role: "user", content: "read a", timestamp: 0 }] } as never,
			credentialOptions,
		).result();

		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toMatchObject([
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a" } },
		]);
	});

	it("fails the turn on an HTTP rejection instead of answering empty", async () => {
		const { stream } = await import("../src/api/qoder.ts");
		vi.stubGlobal("fetch", async () => new Response('{"code":"101","message":"Signature invalid"}', { status: 403 }));

		const result = await stream(
			model(),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never,
			credentialOptions,
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/403/);
	});

	it("needs a device token before it can sign anything", async () => {
		const { stream } = await import("../src/api/qoder.ts");
		vi.stubGlobal("fetch", async () => {
			throw new Error("no request without a token");
		});

		const result = await stream(model(), { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never, {
			signal: neverAbortedSignal,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/device token/);
	});
});
