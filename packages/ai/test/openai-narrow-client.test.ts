import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import NarrowOpenAI from "../src/api/openai-chat-completions-client.ts";

/**
 * The narrow client is what a build ships instead of the `openai` SDK for a
 * flavor whose API set is openai-completions alone (issue #540,
 * scripts/build-openai-client.mjs). These cases pin the behavior the SDK
 * provided on that one path: SSE decoding, the `withResponse()` shape, the
 * status error `normalizeProviderError` reads, and the retry policy.
 */

interface RecordedRequest {
	url: string;
	headers: http.IncomingHttpHeaders;
	body: Record<string, unknown>;
}

async function startServer(
	handler: (request: RecordedRequest, response: http.ServerResponse) => void,
): Promise<{ baseUrl: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
	const requests: RecordedRequest[] = [];
	const server = http.createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		const recorded = {
			url: request.url ?? "",
			headers: request.headers,
			body: body ? (JSON.parse(body) as Record<string, unknown>) : {},
		};
		requests.push(recorded);
		handler(recorded, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		close: async () => {
			server.close();
			await once(server, "close");
		},
	};
}

function streamChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-narrow",
		object: "chat.completion.chunk",
		created: 0,
		model: "narrow-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;
}

function writeSse(response: http.ServerResponse, chunks: string[]): void {
	response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) response.write(chunk);
	response.end();
}

describe("narrow openai client", () => {
	afterEach(() => {
		delete process.env.OPENAI_API_KEY;
	});

	it("streams chat completions chunks with the response attached", async () => {
		const server = await startServer((_request, response) => {
			writeSse(response, [
				streamChunk({ role: "assistant", content: "hello " }),
				streamChunk({ content: "world" }),
				streamChunk({}, "stop"),
				"data: [DONE]\n\n",
			]);
		});
		try {
			const client = new NarrowOpenAI({ apiKey: "test-key", baseURL: `${server.baseUrl}/v1` });
			const { data, response } = await client.chat.completions
				.create({ model: "narrow-model", messages: [], stream: true })
				.withResponse();

			const chunks: Array<{ choices: Array<{ delta: unknown }> }> = [];
			for await (const chunk of data) chunks.push(chunk as { choices: Array<{ delta: unknown }> });

			expect(chunks).toHaveLength(3);
			expect(chunks[0]?.choices[0]?.delta).toEqual({ role: "assistant", content: "hello " });
			expect(chunks[1]?.choices[0]?.delta).toEqual({ content: "world" });
			expect(response.status).toBe(200);
		} finally {
			await server.close();
		}
	});

	it("posts to the chat completions endpoint with the client's headers", async () => {
		const server = await startServer((_request, response) => {
			writeSse(response, [streamChunk({}, "stop"), "data: [DONE]\n\n"]);
		});
		try {
			const client = new NarrowOpenAI({
				apiKey: "test-key",
				baseURL: `${server.baseUrl}/v1/`,
				defaultHeaders: { "X-Custom": "custom-value" },
			});
			const stream = await client.chat.completions.create({
				model: "narrow-model",
				messages: [{ role: "user", content: "hi" }],
				stream: true,
			});
			for await (const _chunk of stream) {
				// Drain the body so the request settles before assertions.
			}

			const [request] = server.requests;
			expect(request?.url).toBe("/v1/chat/completions");
			expect(request?.headers.authorization).toBe("Bearer test-key");
			expect(request?.headers["content-type"]).toBe("application/json");
			expect(request?.headers["x-custom"]).toBe("custom-value");
			expect(request?.body.model).toBe("narrow-model");
			expect(request?.body.stream).toBe(true);
		} finally {
			await server.close();
		}
	});

	it("raises the SDK-shaped status error provider error formatting reads", async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(429, { "content-type": "application/json", "x-request-id": "req-429" });
			response.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
		});
		try {
			const client = new NarrowOpenAI({ apiKey: "test-key", baseURL: `${server.baseUrl}/v1` });
			// The rejection surfaces when the request settles, like the SDK's own
			// `await client.chat.completions.create(...)`.
			const error = await client.chat.completions.create({ model: "narrow-model", messages: [], stream: true }).then(
				() => undefined,
				(caught: { status?: number; error?: unknown; headers?: Headers }) => caught,
			);

			expect(error?.status).toBe(429);
			expect(error?.error).toEqual({ message: "rate limited", type: "rate_limit_error" });
			expect(error?.headers?.get("x-request-id")).toBe("req-429");
		} finally {
			await server.close();
		}
	});

	it("retries a retryable status before giving up on the request", async () => {
		let attempts = 0;
		const server = await startServer((_request, response) => {
			attempts += 1;
			if (attempts === 1) {
				response.writeHead(500, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "transient" } }));
				return;
			}
			writeSse(response, [streamChunk({ content: "recovered" }, "stop"), "data: [DONE]\n\n"]);
		});
		try {
			const client = new NarrowOpenAI({ apiKey: "test-key", baseURL: `${server.baseUrl}/v1` });
			const stream = await client.chat.completions.create({ model: "narrow-model", messages: [], stream: true });
			const chunks: Array<{ choices: Array<{ delta: { content?: string } }> }> = [];
			for await (const chunk of stream) chunks.push(chunk as { choices: Array<{ delta: { content?: string } }> });

			expect(attempts).toBe(2);
			expect(chunks[0]?.choices[0]?.delta.content).toBe("recovered");
		} finally {
			await server.close();
		}
	});

	it("stops at the [DONE] sentinel and reports an SSE error event", async () => {
		const server = await startServer((_request, response) => {
			writeSse(response, [
				streamChunk({ content: "partial" }),
				'event: error\ndata: {"error":{"message":"bad"}}\n\n',
			]);
		});
		try {
			const client = new NarrowOpenAI({ apiKey: "test-key", baseURL: `${server.baseUrl}/v1` });
			const stream = await client.chat.completions.create({ model: "narrow-model", messages: [], stream: true });
			const seen: unknown[] = [];
			const error = await (async () => {
				try {
					for await (const chunk of stream) seen.push(chunk);
					return undefined;
				} catch (caught) {
					return caught as Error;
				}
			})();

			expect(seen).toHaveLength(1);
			expect(error?.message).toContain("bad");
		} finally {
			await server.close();
		}
	});
});
