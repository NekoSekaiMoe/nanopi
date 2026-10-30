/**
 * Wire format for the Antigravity (Cloud Code Assist) backend.
 *
 * The backend speaks the Gemini generateContent schema, but a call goes to a
 * fixed `v1internal:*` action wrapped in an envelope that also carries the Cloud
 * Code project, a request id, and the traffic type:
 *
 *   POST /v1internal:streamGenerateContent?alt=sse
 *   {
 *     project, model, requestType: "agent", requestId, userAgent,
 *     request: { contents, systemInstruction, generationConfig, tools, ... }
 *   }
 *
 * Kept apart from the transport so the transformation stays pure data work.
 */

import type { TranscriptContext } from "../types.ts";

/** Endpoint cascade, in the order the native client tries them. */
export const ENVELOPE_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
];
// Cloud Code rejects newer models from clients below 2.23.0, so this is a floor, not a cap.
export const ANTIGRAVITY_VERSION = "2.23.1";
export const ANTIGRAVITY_CLIENT_NAME = "antigravity";
export const USER_AGENT = `${ANTIGRAVITY_CLIENT_NAME}/hub/${ANTIGRAVITY_VERSION} darwin/arm64`;
export const ANTIGRAVITY_API_CLIENT = `google-cloud-sdk vscode_cloudshelleditor/0.1 ${ANTIGRAVITY_CLIENT_NAME}/${ANTIGRAVITY_VERSION}`;
const MAX_SESSION_SEED_CHARS = 64 * 1024;

type GeminiBody = {
	model?: unknown;
	_url?: unknown;
	_query?: unknown;
	systemInstruction?: { role?: string; parts?: { text?: string }[]; [key: string]: unknown };
	[key: string]: unknown;
};

/** FNV-1a over the first user message: same conversation, same session. */
export function stableSessionId(context: TranscriptContext): string {
	const firstUser = context.messages.find((message) => message.role === "user");
	const seed = firstUser ? JSON.stringify(firstUser).slice(0, MAX_SESSION_SEED_CHARS) : "";
	let hash = 0x811c9dc5;
	for (let index = 0; index < seed.length; index += 1) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `nanopi-${hash.toString(16)}`;
}

/**
 * Claude models on this backend require the Antigravity-shaped system
 * instruction (`role: "user"`); Gemini models accept both forms.
 */
function normalizeSystemInstruction(body: GeminiBody): GeminiBody {
	const parts = body.systemInstruction?.parts?.filter((part) => typeof part.text === "string" && part.text);
	if (!parts || parts.length === 0) return body;
	return { ...body, systemInstruction: { ...body.systemInstruction, role: "user", parts } };
}

export function buildEnvelope(
	body: GeminiBody,
	input: { project: string; modelId: string; sessionId: string },
): Record<string, unknown> {
	const { model: _model, _url: _ignoredUrl, _query: _ignoredQuery, ...request } = body;
	const normalized = normalizeSystemInstruction(request);
	// Only Claude models carry a session id; Gemini rejects the unknown field.
	if (input.modelId.toLowerCase().includes("claude")) normalized.sessionId = input.sessionId;
	return {
		project: input.project,
		model: input.modelId,
		requestType: "agent",
		requestId: `agent-${crypto.randomUUID()}`,
		userAgent: ANTIGRAVITY_CLIENT_NAME,
		request: normalized,
	};
}

/**
 * Headers the native client puts on every Cloud Code call. The Google SDK client
 * built underneath always identifies itself as `nanopi (...)`, so the Antigravity
 * identity has to be layered on top of it.
 */
export function clientHeaders(): Record<string, string> {
	return {
		"User-Agent": USER_AGENT,
		"X-Client-Name": ANTIGRAVITY_CLIENT_NAME,
		"X-Client-Version": ANTIGRAVITY_VERSION,
		"X-Goog-Api-Client": ANTIGRAVITY_API_CLIENT,
	};
}
