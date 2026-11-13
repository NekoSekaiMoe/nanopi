import { afterEach, describe, expect, it, vi } from "vitest";
import { parseQoderStreamFrame } from "../src/qoder/chat.ts";
import { qoderEndpoints } from "../src/qoder/endpoints.ts";
import { encodeQoderBody, renewQoderToken } from "../src/qoder/job-token.ts";

const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

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

describe("Qoder login expiry", () => {
	it("marks the 105 Login expired envelope as a token the caller can renew", () => {
		const delta = parseQoderStreamFrame(JSON.stringify(frame({ code: "105", message: "Login expired" }, 403)));

		expect(delta.tokenExpired).toBe(true);
		expect(delta.error).toMatch(/HTTP 403.*Login expired/);
		expect(delta.error).toMatch(/\/login qoder/);
	});

	it("leaves every other upstream error alone", () => {
		expect(
			parseQoderStreamFrame(JSON.stringify(frame({ code: "101", message: "Signature invalid" }, 403))),
		).toMatchObject({ error: expect.stringMatching(/Signature invalid/) });
		expect(
			parseQoderStreamFrame(JSON.stringify(frame({ code: "101", message: "Signature invalid" }, 403))).tokenExpired,
		).toBeUndefined();
	});

	it("renews the pair once the stream reports the expiry, and reports the new tokens", async () => {
		const { stream } = await import("../src/api/qoder.ts");
		const endpoints = qoderEndpoints("global");
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (input: unknown) => {
			const url = String(input);
			requests.push(url);
			if (url === endpoints.jobTokenUrl) return jsonResponse({ device_token: "dt-new", refresh_token: "drt-new" });
			// The first turn is answered with a stream that only carries the expiry frame.
			if (requests.filter((entry) => entry === endpoints.chatUrl).length === 1) {
				return sseStream([frame({ code: "105", message: "Login expired" }, 403)]);
			}
			return sseStream([frame({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })]);
		});

		let stored: unknown;
		const result = await stream(model(), { messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never, {
			...credentialOptions,
			env: { ...credentialOptions.env, QODER_ACCOUNT_REFRESH_TOKEN: "drt-old" },
			onAuthorizationUpdate: (update) => {
				stored = update;
			},
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toMatchObject([{ type: "text", text: "hi" }]);
		expect(stored).toEqual({ token: "dt-new", refreshToken: "drt-new", continues: true });
		expect(requests.filter((url) => url === endpoints.chatUrl)).toHaveLength(2);
	});

	it("fails with the expiry when the credential has no refresh token to renew with", async () => {
		const { stream } = await import("../src/api/qoder.ts");
		vi.stubGlobal("fetch", async () => sseStream([frame({ code: "105", message: "Login expired" }, 403)]));

		const result = await stream(
			model(),
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never,
			credentialOptions,
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/Login expired/);
		expect(result.errorMessage).toMatch(/\/login qoder/);
	});
});

describe("Qoder job token exchange", () => {
	it("encodes the body with Qoder's own alphabet", () => {
		const encoded = encodeQoderBody(new TextEncoder().encode('{"payload":"x","encodeVersion":"1"}'));

		// Standard base64 of that body, rotated by the trailing third and remapped onto
		// Qoder's alphabet: the characters of plain base64 never survive as-is.
		const standard = Buffer.from('{"payload":"x","encodeVersion":"1"}').toString("base64");
		// Every character comes from Qoder's alphabet, so none of the standard one survives as-is.
		expect(encoded.length).toBe(standard.length);
		expect(encoded).not.toBe(standard);
		expect(encoded).not.toMatch(/^[A-Za-z0-9+/]+$/);
	});

	it("rotates a padded body the way the client does, padding included", () => {
		// The exchange body is 185 bytes, so its base64 is padded. Padding is part of
		// the rotation: stripping it first shifts every character of a padded body,
		// which the endpoint answers with 401.
		const plain = new Uint8Array(Buffer.alloc(185, 7));
		const encoded = encodeQoderBody(plain);

		const standard = Buffer.from(plain).toString("base64");
		const third = Math.floor(standard.length / 3);
		const rotated =
			standard.slice(standard.length - third) +
			standard.slice(third, standard.length - third) +
			standard.slice(0, third);
		const alphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
		const expected = [...rotated]
			.map((char) => {
				const index = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(char);
				return index === -1 ? "$" : alphabet[index];
			})
			.join("");

		expect(encoded).toBe(expected);
		expect(encoded).toContain("$");
	});

	it("asks for a rotation when it redeems a refresh token", async () => {
		let body = "";
		let headers: Headers | undefined;
		vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
			body = String(init?.body);
			headers = new Headers(init?.headers);
			return jsonResponse({ device_token: "dt-new", refresh_token: "drt-new" });
		});

		const renewed = await renewQoderToken({
			credential: "drt-old",
			jobTokenUrl: qoderEndpoints("global").jobTokenUrl,
			signal: neverAbortedSignal,
		});

		expect(renewed).toEqual({ token: "dt-new", refreshToken: "drt-new" });
		expect(headers?.get("signature")).toMatch(/^[0-9a-f]{32}$/);
		expect(headers?.get("appcode")).toBe("cosy");
		// A request without the device headers is refused with 401, so the exchange
		// presents the same derived identity the signed calls do.
		expect(headers?.get("cosy-machineid")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(headers?.get("cosy-machinetoken")).toHaveLength(43);
		expect(headers?.get("cosy-machinetype")).toHaveLength(18);
		// The encoded payload carries needRefresh, so upstream rotates the pair.
		expect(body.length).toBeGreaterThan(0);
		expect(body).not.toContain("drt-old");
	});

	it("keeps the redeemed refresh token when the exchange answers with a device token only", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ device_token: "dt-new" }));

		const renewed = await renewQoderToken({
			credential: "drt-old",
			jobTokenUrl: qoderEndpoints("global").jobTokenUrl,
			signal: neverAbortedSignal,
		});

		expect(renewed).toEqual({ token: "dt-new", refreshToken: "drt-old" });
	});

	it("reports a rejected exchange instead of an empty token", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ message: "personal token is invalid" }, 200));

		await expect(
			renewQoderToken({
				credential: "drt-old",
				jobTokenUrl: qoderEndpoints("global").jobTokenUrl,
				signal: neverAbortedSignal,
			}),
		).rejects.toThrow(/returned no device token/);
	});
});
