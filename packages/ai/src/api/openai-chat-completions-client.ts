/**
 * Runtime client behind the `openai` imports of a build whose API set is
 * openai-completions alone (`apiSets.openai` in buildconfig.json).
 *
 * Problem: the SDK root barrel aggregates every resource (responses,
 * assistants, realtime, beta, admin, vector stores, ...), so
 * `import OpenAI from "openai"` pulls all of it — 1379 KiB of inputs in the
 * minimal single file, where the chat-completions path runs a fraction of
 * that. Importing the client module alone does not help: its constructor
 * instantiates the whole resource tree, so the same modules come back through
 * the class's own references.
 *
 * Solution: this module implements the one method `openai-completions.ts`
 * calls — `chat.completions.create(...).withResponse()` — over the SDK pieces
 * that method needs instead of the aggregate client:
 *
 * - `core/api-promise.mjs`, `core/error.mjs`, `core/streaming.mjs` and
 *   `lib/chat-completions/streaming.mjs` for the request promise, the status
 *   error mapping `normalizeProviderError` reads, and SSE decoding.
 * - a JSON request with the full client's behavior: same URL joining, same
 *   header set, same retry policy (backoff, `retry-after`), same timeout.
 *
 * scripts/build-openai-client.mjs resolves the bare `openai` specifier to this
 * module for that API set only. The types an importer reads (`OpenAI`,
 * `OpenAI.Chat.Completions.*`, the `openai/resources/chat/completions.js`
 * names) still come from the package, so a renamed or moved SDK symbol fails
 * type checking instead of silently changing behavior.
 */

import { APIPromise } from "openai/core/api-promise.mjs";
import { APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai/core/error.mjs";
import { Stream } from "openai/core/streaming.mjs";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";

/** Client options: the subset `openai-completions.ts` sets. */
export interface NarrowClientOptions {
	apiKey: string;
	baseURL: string;
	dangerouslyAllowBrowser?: boolean;
	fetch?: typeof globalThis.fetch;
	defaultHeaders?: Record<string, string | null | undefined>;
}

/** Request options: the subset `openai-completions.ts` passes. */
export interface NarrowRequestOptions {
	signal?: AbortSignal;
	timeout?: number;
	maxRetries?: number;
}

export interface NarrowCompletions {
	create(
		body: Record<string, unknown> & { stream?: boolean },
		options?: NarrowRequestOptions,
	): APIPromise<Stream<ChatCompletionChunk>>;
}

export interface NarrowChat {
	completions: NarrowCompletions;
}

const USER_AGENT = "NarrowOpenAI/JS nanopi";
const DEFAULT_TIMEOUT = 600_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_AFTER_MAX_MILLIS = 60_000;
const PLATFORM_HEADERS = {
	"X-Stainless-Lang": "js",
	"X-Stainless-Package-Version": "nanopi",
	"X-Stainless-OS": process.platform,
	"X-Stainless-Arch": process.arch,
	"X-Stainless-Runtime": "node",
	"X-Stainless-Runtime-Version": process.version,
} as const;

function isAbsoluteURL(value: string): boolean {
	try {
		new URL(value);
		return true;
	} catch {
		return false;
	}
}

/** Default backoff of the SDK client: 0.5s doubling to 8s, up to 25% jitter. */
function defaultRetryDelayMillis(retriesRemaining: number, maxRetries: number): number {
	const seconds = Math.min(0.5 * 2 ** (maxRetries - retriesRemaining), 8);
	return seconds * (1 - Math.random() * 0.25) * 1000;
}

function retryAfterMillis(headers: Headers): number | undefined {
	const milliseconds = headers.get("retry-after-ms");
	if (milliseconds) {
		const value = Number.parseFloat(milliseconds);
		if (!Number.isNaN(value)) return value;
	}
	const after = headers.get("retry-after");
	if (!after) return undefined;
	const value = Number.parseFloat(after);
	if (!Number.isNaN(value)) return value * 1000;
	const date = Date.parse(after);
	return Number.isNaN(date) ? undefined : date - Date.now();
}

function shouldRetry(response: Response): boolean {
	// Not a standard header, but the server's answer wins when present.
	const explicit = response.headers.get("x-should-retry");
	if (explicit === "true") return true;
	if (explicit === "false") return false;
	return response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
}

function normalizeRetries(value: number): number {
	return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_MAX_RETRIES;
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new APIUserAbortError());
			return;
		}
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, milliseconds);
		const onAbort = () => {
			clearTimeout(timer);
			cleanup();
			reject(new APIUserAbortError());
		};
		const cleanup = () => signal?.removeEventListener("abort", onAbort);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** `Completions` for one endpoint: `POST {baseURL}/chat/completions`. */
class NarrowCompletionsResource implements NarrowCompletions {
	private readonly client: NarrowOpenAI;

	constructor(client: NarrowOpenAI) {
		this.client = client;
	}

	create(
		body: Record<string, unknown> & { stream?: boolean },
		options?: NarrowRequestOptions,
	): APIPromise<Stream<ChatCompletionChunk>> {
		return this.client.request(body, options);
	}
}

export class NarrowOpenAI {
	static readonly DEFAULT_TIMEOUT = DEFAULT_TIMEOUT;

	readonly apiKey: string;
	readonly baseURL: string;
	readonly maxRetries: number;
	readonly timeout: number;
	readonly chat: NarrowChat;

	private readonly fetchImpl: typeof globalThis.fetch;
	private readonly defaultHeaders: Record<string, string | null | undefined> | undefined;

	constructor(options: NarrowClientOptions) {
		if (!options.apiKey) {
			throw new APIError(
				undefined,
				undefined,
				"Missing credentials. Please pass an `apiKey`, or set the `OPENAI_API_KEY` environment variable.",
				undefined,
			);
		}
		const fetchImpl = options.fetch ?? globalThis.fetch;
		if (typeof fetchImpl !== "function") {
			throw new Error(
				"`fetch` is not defined as a global; pass `fetch` to the client, `new OpenAI({ fetch })` or polyfill the global, `globalThis.fetch = fetch`",
			);
		}
		this.apiKey = options.apiKey;
		this.baseURL = options.baseURL || "https://api.openai.com/v1";
		this.fetchImpl = fetchImpl;
		this.defaultHeaders = options.defaultHeaders;
		this.maxRetries = DEFAULT_MAX_RETRIES;
		this.timeout = DEFAULT_TIMEOUT;
		this.chat = { completions: new NarrowCompletionsResource(this) };
	}

	/**
	 * One API promise per call, retried in place: `.withResponse()` reports the
	 * response the final attempt saw, like the SDK's `client.request`.
	 */
	request(
		body: Record<string, unknown> & { stream?: boolean },
		options: NarrowRequestOptions | undefined,
	): APIPromise<Stream<ChatCompletionChunk>> {
		const maxRetries = normalizeRetries(options?.maxRetries ?? this.maxRetries);
		const controller = new AbortController();
		const signal = options?.signal;
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });

		const responsePromise = this.makeRequest(body, options, maxRetries, controller).finally(() =>
			signal?.removeEventListener("abort", abort),
		);

		return new APIPromise<Stream<ChatCompletionChunk>>(
			// The APIPromise only uses the client for debug logging, which the narrow
			// client does not do; the SDK types the parameter as its own client.
			this as unknown as ConstructorParameters<typeof APIPromise<Stream<ChatCompletionChunk>>>[0],
			responsePromise,
			async (_client, props) => Stream.fromSSEResponse<ChatCompletionChunk>(props.response, props.controller),
		);
	}

	private async makeRequest(
		body: Record<string, unknown> & { stream?: boolean },
		options: NarrowRequestOptions | undefined,
		retriesRemaining: number,
		controller: AbortController,
	): Promise<{
		response: Response;
		options: { method: "post"; path: string; body: unknown; stream?: boolean };
		controller: AbortController;
		requestLogID: string;
		retryOfRequestLogID: string | undefined;
		startTime: number;
	}> {
		const signal = options?.signal;
		if (signal?.aborted || controller.signal.aborted) {
			throw new APIUserAbortError();
		}

		const timeout = options?.timeout ?? this.timeout;
		const url = this.buildURL();
		const timer = setTimeout(() => controller.abort(), timeout);
		const startTime = Date.now();
		let response: Response;
		try {
			// `undefined` this binding: fetch implementations reject a bound receiver.
			response = await (this.fetchImpl as (...args: Parameters<typeof fetch>) => Promise<Response>).call(
				undefined,
				url,
				{
					method: "POST",
					headers: this.buildHeaders(),
					body: JSON.stringify(body),
					signal: controller.signal,
				},
			);
		} catch (error) {
			if (signal?.aborted) throw new APIUserAbortError();
			if (controller.signal.aborted) throw new APIConnectionTimeoutError();
			if (retriesRemaining > 0) {
				await abortableDelay(
					defaultRetryDelayMillis(retriesRemaining, normalizeRetries(options?.maxRetries ?? this.maxRetries)),
					signal,
				);
				return this.makeRequest(body, options, retriesRemaining - 1, new AbortController());
			}
			throw new APIError(
				undefined,
				{ message: error instanceof Error ? error.message : String(error) },
				undefined,
				undefined,
			);
		} finally {
			clearTimeout(timer);
		}

		if (!response.ok) {
			if (retriesRemaining > 0 && shouldRetry(response)) {
				const after = retryAfterMillis(response.headers);
				await response.body?.cancel().catch(() => undefined);
				await abortableDelay(
					after !== undefined && after >= 0 && after <= RETRY_AFTER_MAX_MILLIS
						? after
						: defaultRetryDelayMillis(retriesRemaining, normalizeRetries(options?.maxRetries ?? this.maxRetries)),
					signal,
				);
				return this.makeRequest(body, options, retriesRemaining - 1, new AbortController());
			}
			// Unread error bodies were already consumed above when a retry follows.
			const text = response.bodyUsed ? "" : await response.text().catch(() => "");
			let parsed: unknown;
			try {
				parsed = text ? JSON.parse(text) : undefined;
			} catch {
				parsed = undefined;
			}
			throw APIError.generate(
				response.status,
				parsed as object | undefined,
				parsed === undefined ? text : undefined,
				response.headers,
			);
		}

		return {
			response,
			options: { method: "post", path: "/chat/completions", body, stream: body.stream === true },
			controller,
			requestLogID: `log_${((Math.random() * (1 << 24)) | 0).toString(16).padStart(6, "0")}`,
			retryOfRequestLogID: undefined,
			startTime,
		};
	}

	private buildHeaders(): Headers {
		const headers = new Headers({
			Accept: "application/json",
			"User-Agent": USER_AGENT,
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
			...PLATFORM_HEADERS,
		});
		for (const [name, value] of Object.entries(this.defaultHeaders ?? {})) {
			const lower = name.toLowerCase();
			if (value === undefined) continue;
			// A null entry removes a header the client would set by default; the
			// chat-completions caller only ever adds headers, so an explicit null
			// simply leaves the default in place.
			if (value === null) continue;
			headers.set(lower, value);
		}
		return headers;
	}

	/** Base URL plus the endpoint path, joined like the SDK's `buildURL`. */
	private buildURL(): string {
		const path = "/chat/completions";
		if (isAbsoluteURL(path)) return path;
		if (this.baseURL.includes("?")) {
			const base = new URL(this.baseURL);
			base.search = "";
			base.hash = "";
			const joined = base.toString().replace(/\/$/, "");
			return joined.endsWith("/") && path.startsWith("/") ? joined + path.slice(1) : joined + path;
		}
		return this.baseURL.endsWith("/") && path.startsWith("/")
			? this.baseURL.slice(0, -1) + path
			: this.baseURL + path;
	}
}

export default NarrowOpenAI;
