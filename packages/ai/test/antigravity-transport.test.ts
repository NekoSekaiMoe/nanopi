import { describe, expect, it, vi } from "vitest";
import { antigravityFetch } from "../src/api/antigravity.ts";
import { buildEnvelope, stableSessionId } from "../src/api/antigravity-request.ts";
import type { Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"antigravity"> = {
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6 (Antigravity)",
	api: "antigravity",
	provider: "antigravity",
	baseUrl: "https://daily-cloudcode-pa.googleapis.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 262144,
	maxTokens: 64000,
};

const context: TranscriptContext = normalizeContext({
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
});

/** What the Google SDK hands a fetcher: its own URL, its own JSON body. */
const SDK_URL = "https://daily-cloudcode-pa.googleapis.com/models/claude-sonnet-4-6:streamGenerateContent?alt=sse";
const SDK_BODY = JSON.stringify({
	contents: [{ role: "user", parts: [{ text: "hi" }] }],
	generationConfig: { maxOutputTokens: 64 },
});

function sse(): Response {
	return new Response("data: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function recording(): { baseFetch: typeof fetch; calls: { url: string; body: unknown; headers: Headers }[] } {
	const calls: { url: string; body: unknown; headers: Headers }[] = [];
	const baseFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		calls.push({
			url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			body: JSON.parse(String(init?.body)),
			headers: new Headers(init?.headers),
		});
		return sse();
	});
	return { baseFetch: baseFetch as unknown as typeof fetch, calls };
}

describe("Antigravity request envelope", () => {
	it("nests the Gemini payload and keeps the project at the top level", () => {
		const envelope = buildEnvelope(JSON.parse(SDK_BODY), {
			project: "project-42",
			modelId: "claude-sonnet-4-6",
			sessionId: "session-1",
		});
		expect(envelope.project).toBe("project-42");
		expect(envelope.model).toBe("claude-sonnet-4-6");
		expect(envelope.requestType).toBe("agent");
		expect(envelope.userAgent).toBe("antigravity");
		expect(String(envelope.requestId)).toMatch(/^agent-/);
		const request = envelope.request as Record<string, unknown>;
		expect(request.sessionId).toBe("session-1");
		expect(request.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
		expect(request.generationConfig).toEqual({ maxOutputTokens: 64 });
	});

	it("gives the system instruction the shape Claude models require", () => {
		const envelope = buildEnvelope(
			{ systemInstruction: { parts: [{ text: "be brief" }] }, contents: [] },
			{ project: "p", modelId: "claude-sonnet-4-6", sessionId: "s" },
		);
		expect((envelope.request as Record<string, unknown>).systemInstruction).toEqual({
			role: "user",
			parts: [{ text: "be brief" }],
		});
	});

	it("omits the session id for Gemini models", () => {
		const envelope = buildEnvelope({ contents: [] }, { project: "p", modelId: "gemini-3.1-pro", sessionId: "s" });
		expect((envelope.request as Record<string, unknown>).sessionId).toBeUndefined();
	});

	it("derives a stable session id from the first user message", () => {
		expect(stableSessionId(context)).toBe(stableSessionId(context));
		expect(stableSessionId(context)).not.toBe(
			stableSessionId(normalizeContext({ messages: [{ role: "user", content: "bye", timestamp: 0 }] })),
		);
	});
});

describe("Antigravity fetch rewrite", () => {
	it("posts the envelope to the fixed streamGenerateContent action", async () => {
		const { baseFetch, calls } = recording();
		const fetchImpl = antigravityFetch(baseFetch, model, "access-token", "project-42", "session-1");

		await fetchImpl(SDK_URL, { method: "POST", body: SDK_BODY });

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
		expect(call.headers.get("authorization")).toBe("Bearer access-token");
		expect(call.headers.get("user-agent")).toContain("antigravity/hub/");
		expect(call.headers.get("x-goog-api-key")).toBeNull();
		expect(call.body).toMatchObject({ project: "project-42", requestType: "agent", model: "claude-sonnet-4-6" });
	});

	it("cascades to the next endpoint when one returns 403 or 404", async () => {
		const urls: string[] = [];
		const baseFetch = vi.fn(async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			urls.push(url);
			if (url.includes("sandbox")) return new Response("missing", { status: 404 });
			if (url.includes("daily")) return new Response("denied", { status: 403 });
			return sse();
		});
		const fetchImpl = antigravityFetch(
			baseFetch as unknown as typeof fetch,
			model,
			"access-token",
			"project-42",
			"session-1",
		);

		const response = await fetchImpl(SDK_URL, { method: "POST", body: SDK_BODY });

		expect(response.status).toBe(200);
		expect(urls.map((url) => new URL(url).host)).toEqual([
			"daily-cloudcode-pa.googleapis.com",
			"daily-cloudcode-pa.sandbox.googleapis.com",
			"cloudcode-pa.googleapis.com",
		]);
	});
});
