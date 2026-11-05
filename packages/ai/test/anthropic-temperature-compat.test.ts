import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface AnthropicTemperaturePayload {
	temperature?: number;
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

function makeCustomModel(compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> {
	return {
		id: "vendor--claude-opus-4-7",
		name: "Vendor Proxy Opus 4.7",
		api: "anthropic-messages",
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat,
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicTemperaturePayload> {
	let capturedPayload: AnthropicTemperaturePayload | undefined;

	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makeContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicTemperaturePayload;
			throw new PayloadCaptured();
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic temperature compatibility", () => {
	it("omits temperature for Claude Opus 4.7", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"), { temperature: 0 });

		expect(payload.temperature).toBeUndefined();
	});

	it("omits temperature for Claude Opus 4.8", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-8"), { temperature: 0 });

		expect(payload.temperature).toBeUndefined();
	});

	it("omits default temperature for Claude Opus 4.7", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-7"), { temperature: 1 });

		expect(payload.temperature).toBeUndefined();
	});

	it("keeps temperature for Claude Opus 4.6", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-6"), { temperature: 0 });

		expect(payload.temperature).toBe(0);
	});

	it("keeps temperature for Claude Sonnet 4.6", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-6"), { temperature: 0 });

		expect(payload.temperature).toBe(0);
	});

	// The SDK 1.x request type has no `temperature` field, so the assignment goes through a
	// widened cast. This runs the field through the real client to prove it still reaches the body.
	it("puts temperature on the wire for models that accept it", async () => {
		let body: { temperature?: number } | undefined;
		const fetchStub = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			body = JSON.parse(String(init?.body)) as { temperature?: number };
			return new Response("data: [DONE]\n\n", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
		const s = streamSimple(getModel("anthropic", "claude-sonnet-4-6"), makeContext(), {
			apiKey: "fake-key",
			temperature: 0,
			fetch: fetchStub as typeof fetch,
		});
		await s.result().catch(() => undefined);

		expect(body?.temperature).toBe(0);
	});

	// 2023-06-01 is not deprecated and stays supported, so a model pinned to it still needs the
	// field. The client default is 2026-10-21; `model.headers` is what puts a request back on the
	// older version. This asserts both halves of that contract.
	it("puts 2023-06-01 on the wire when the model pins it, and the client default otherwise", async () => {
		const send = async (model: Model<"anthropic-messages">): Promise<Record<string, string>> => {
			let headers: Record<string, string> = {};
			const fetchStub = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				headers = Object.fromEntries(new Headers(init?.headers).entries());
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			};
			const s = streamSimple(model, makeContext(), {
				apiKey: "fake-key",
				temperature: 0,
				fetch: fetchStub as typeof fetch,
			});
			await s.result().catch(() => undefined);
			return headers;
		};

		const pinned = await send({
			...getModel("anthropic", "claude-sonnet-4-6"),
			headers: { "anthropic-version": "2023-06-01" },
		});
		expect(pinned["anthropic-version"]).toBe("2023-06-01");

		const unpinned = await send(getModel("anthropic", "claude-sonnet-4-6"));
		expect(unpinned["anthropic-version"]).toBe("2026-10-21");
	});

	it("omits temperature for custom models with supportsTemperature disabled", async () => {
		const payload = await capturePayload(makeCustomModel({ supportsTemperature: false }), { temperature: 0 });

		expect(payload.temperature).toBeUndefined();
	});
});
