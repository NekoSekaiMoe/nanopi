/**
 * Google Antigravity (Cloud Code Assist) transport.
 *
 * The backend speaks the Gemini generateContent schema, but a call goes to a
 * fixed `v1internal:*` action wrapped in an envelope carrying the Cloud Code
 * project, a request id, and the traffic type:
 *
 *   POST /v1internal:streamGenerateContent?alt=sse
 *   {
 *     project, model, requestType: "agent", requestId, userAgent,
 *     request: { contents, systemInstruction, generationConfig, tools, ... }
 *   }
 *
 * The Google SDK builds its own `<base>/models/<id>:streamGenerateContent` URL
 * and reads `globalThis.fetch` at request time, with no supported per-call hook
 * for either, so the envelope is installed as a scoped `fetch` override around
 * the reused Gemini adapter. The override ends once the response headers are in;
 * the adapter then reads the body without touching `fetch` again.
 *
 * Session affinity matters: the backend caches prompt state per `sessionId`, so
 * it is derived from the first user message and stays stable across turns.
 */

import type {
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamOptions,
	TranscriptContext,
} from "../types.ts";
import { buildEnvelope, clientHeaders, ENVELOPE_ENDPOINTS, stableSessionId } from "./antigravity-request.ts";
import { stream as geminiStream, streamSimple as geminiStreamSimple } from "./google-generative-ai.ts";
import { lazyStream } from "./lazy.ts";

const STREAM_ACTION = "/v1internal:streamGenerateContent";
const GENERATE_ACTION = "/v1internal:generateContent";

type AntigravityOptions = {
	apiKey?: string;
	env?: Record<string, string>;
	/** Explicit request headers: they replace the SDK client's, not just layer on top of them. */
	headers?: ProviderHeaders;
};

type Run = () => Promise<AsyncIterable<AssistantMessageEvent>>;

function projectId(options: AntigravityOptions | undefined): string {
	return options?.env?.ANTIGRAVITY_PROJECT_ID ?? "";
}

/**
 * Installs the Antigravity rewrite as `globalThis.fetch` for the duration of
 * `run`, which ends when the response headers arrive.
 *
 * The override is process-global, so a concurrent Gemini request would be
 * rewritten too. The window is one round trip and the message schema is shared,
 * so the worst case is an Antigravity envelope sent with the other call's token
 * — a failed request, not a corrupted session.
 */
export async function withAntigravityFetch(
	model: Model<"antigravity">,
	accessToken: string,
	project: string,
	context: TranscriptContext,
	run: Run,
	headers?: ProviderHeaders,
	baseFetch: typeof fetch = globalThis.fetch,
): Promise<AsyncIterable<AssistantMessageEvent>> {
	const sessionId = stableSessionId(context);
	globalThis.fetch = antigravityFetch(baseFetch, model, accessToken, project, sessionId, headers);

	try {
		return await run();
	} finally {
		globalThis.fetch = baseFetch;
	}
}

/**
 * The rewrite itself: reads a Gemini-shaped call and re-emits it as the Antigravity
 * envelope, cascading across endpoints when one does not serve the account.
 */
export function antigravityFetch(
	baseFetch: typeof fetch,
	model: Model<"antigravity">,
	accessToken: string,
	project: string,
	sessionId: string,
	headers?: ProviderHeaders,
): typeof fetch {
	return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const sdkUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const body = (typeof init?.body === "string" ? JSON.parse(init.body) : {}) as Record<string, unknown>;
		const streaming = sdkUrl.includes(":streamGenerateContent");
		const envelope = buildEnvelope(body, { project, modelId: model.id, sessionId });
		const send = (endpoint: string) =>
			baseFetch(`${endpoint}${streaming ? STREAM_ACTION : GENERATE_ACTION}?alt=sse`, {
				...init,
				headers: requestHeaders(model, accessToken, headers),
				body: JSON.stringify(envelope),
			});
		let last: Response | undefined;
		for (const endpoint of ENVELOPE_ENDPOINTS) {
			const response = await send(endpoint);
			// 403/404 means this endpoint does not serve the account; cascade instead of failing.
			if (response.status !== 403 && response.status !== 404) return response;
			last = response;
		}
		return last as Response;
	}) as typeof fetch;
}

/**
 * The SDK client sends its own headers (`nanopi (...)` included), and those win
 * over the ones the adapter sets, so a header that has to look like the native
 * client's forces the client to build without headers at all (see
 * `buildClient`); what lands here is what the request carries.
 */
function requestHeaders(
	model: Model<"antigravity">,
	accessToken: string,
	overrides?: ProviderHeaders,
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		...clientHeaders(),
		...model.headers,
	};
	for (const [name, value] of Object.entries(overrides ?? {})) {
		if (value === null) delete headers[name];
		else headers[name] = value;
	}
	headers.Authorization = `Bearer ${accessToken}`;
	return headers;
}

function startStream(
	model: Model<"antigravity">,
	context: TranscriptContext,
	options: StreamOptions | SimpleStreamOptions | undefined,
	streamFn: typeof geminiStream | typeof geminiStreamSimple,
): AssistantMessageEventStream {
	const accessToken = options?.apiKey;
	if (!accessToken) throw new Error(`No access token for provider: ${model.provider}`);
	const headers = options as AntigravityOptions | undefined;
	// The Gemini adapter merges these into the SDK client, whose headers beat the
	// ones the rewrite sets. The client is what the `Authorization` header has to
	// carry; the identity headers are dropped here and rebuilt per request.
	const { Authorization: _authorization, ...identity } = requestHeaders(model, accessToken, headers?.headers);
	const clientOptions = {
		...options,
		headers: { ...(options as StreamOptions).headers, ...identity },
	} as StreamOptions;
	return lazyStream(
		model,
		async () => streamFn(model as unknown as Model<"google-generative-ai">, context, clientOptions as never),
		(run) => withAntigravityFetch(model, accessToken, projectId(headers), context, run, headers?.headers),
	);
}

export const stream = (
	model: Model<"antigravity">,
	context: TranscriptContext,
	options?: StreamOptions,
): AssistantMessageEventStream => startStream(model, context, options, geminiStream);

export const streamSimple = (
	model: Model<"antigravity">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => startStream(model, context, options, geminiStreamSimple);
