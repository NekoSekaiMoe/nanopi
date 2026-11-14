import { formatThrownValue } from "./diagnostics.ts";

// Shared normalization for provider HTTP error objects.
//
// Endpoints behind a proxy / gateway may return a non-2xx response whose body
// the provider SDK cannot fold into `error.message`. The SDK error object still
// carries the HTTP status and the raw/parsed body, but under SDK-specific field
// names. Provider catch blocks that read only `error.message` therefore drop
// the body and surface opaque messages like `"403 status code (no body)"` or
// collapse to `"Unknown: UnknownError"`.
//
// `normalizeProviderError` probes the known SDK field shapes (Mistral,
// `openai`, `@google/genai`, AWS Bedrock) and returns a struct each provider
// composes into its display string. The `messageCarriesBody` flag captures the
// Anthropic / `@google/genai` happy path where the SDK already folded the body
// into the message, so providers can preserve it without double-printing.

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;

export interface NormalizedProviderError {
	/** HTTP status code, when one could be extracted from the SDK error object. */
	status?: number;
	/** Raw HTTP body reason, already trimmed and truncated to the cap. */
	body?: string;
	/** `error.message`, or `safeJsonStringify(error)` for a non-`Error` throw. */
	message: string;
	/** True when `message` already contains the body (no separate body to add). */
	messageCarriesBody: boolean;
	/** Innermost `cause` message, set only when the error has neither a status nor a body. */
	cause?: string;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const messageCarriesBody = body === undefined || error.message.includes(body);

	return {
		status,
		body,
		message: error.message,
		messageCarriesBody,
		// Only reachable when the error carries no status and no body: the reason
		// then lives nowhere else. A body or a status IS the reason, and appending
		// the chain under it only repeats the message or adds transport noise.
		...(status === undefined && body === undefined ? { cause: deepestCause(error) } : {}),
	} satisfies NormalizedProviderError;
}

/** The innermost `cause` message, which is where `fetch failed` keeps its reason. */
export function deepestCause(error: Error): string | undefined {
	let detail: string | undefined;
	let current: unknown = error.cause;
	// Bounded: a cause cycle would otherwise spin forever.
	for (let depth = 0; current !== undefined && current !== null && depth < 8; depth++) {
		const message = formatThrownValue(current).trim();
		if (message) detail = message;
		current = current instanceof Error ? current.cause : undefined;
	}
	return detail;
}

function withCauseDetail(text: string, cause: string | undefined): string {
	if (!cause || text.includes(cause)) return text;
	return `${text}: ${cause}`;
}

/**
 * Probe the HTTP status, first numeric hit wins, in SDK-field order:
 * `statusCode` (Mistral) → `status` (`openai`, `@google/genai`) →
 * `$metadata.httpStatusCode` (Bedrock) → `$response.statusCode` (Bedrock).
 */
function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

/**
 * Probe the raw body reason, first usable hit wins, in SDK-field order:
 * `body` string (Mistral) → `error` parsed JSON body object (`openai` SDK's
 * `this.error`) → `$response.body` (Bedrock). Empty objects and unread response
 * streams are treated as no body so they do not surface as `"{}"` or serialized
 * stream internals. The chosen body is truncated to the cap.
 */
function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isPlainNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isReadableStreamLike(responseBody)) return undefined;
	if (isPlainNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isReadableStreamLike(value: unknown): boolean {
	return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}

/**
 * Only a PLAIN object counts as an HTTP body. SDK error fields can hold class
 * instances instead of parsed bodies — AWS SDK v3's `$response.body` is an
 * HTTP stream/response wrapper object, and stringifying one produced garbage
 * like `{"_events":...}` as the "body", which then REPLACED `error.message`
 * in the composed display string. `error.message` is where the SDK puts the
 * real deserialized exception text ("Input is too long...", schema validation
 * details, ...), so the one useful string was discarded for noise. A class
 * instance yields no body, `messageCarriesBody` stays true, and the real
 * message survives. Complements the `pipe` sniffing above: web
 * ReadableStreams (pipeTo/pipeThrough, no `pipe`) and non-stream SDK wrapper
 * classes fail the prototype check, while parsed JSON bodies (plain objects
 * by construction) still pass.
 */
function isPlainNonEmptyObject(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	return Object.keys(value).length > 0;
}

/**
 * Compose a display string from a normalized error. When no body/status was
 * extracted, the message is returned unchanged. Otherwise the status and body
 * are surfaced, with an optional provider prefix. When the message already
 * carries the body (Anthropic / `@google/genai` happy path) the message is kept
 * as-is, but the status prefix is still added: the retry classifier reads the
 * display string, so dropping the status drops the only evidence that a 429 was
 * a throttle (`payload too large`, `1308`, ... do not match by themselves).
 *
 * - no prefix: `"<status>: <body>"` / `"<status>: <message>"`
 * - prefix:    `"<prefix> (<status>): <body>"` / `"<prefix> (<status>): <message>"`
 */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	const text = withCauseDetail(
		norm.messageCarriesBody || norm.body === undefined ? norm.message : norm.body,
		norm.cause,
	);
	const alreadyPrefixed =
		norm.status !== undefined && new RegExp(`^\\w[\\w -]* \\(${norm.status}\\):`).test(norm.message);
	if (norm.status === undefined || alreadyPrefixed) return text;
	if (prefix !== undefined) return `${prefix} (${norm.status}): ${text}`;
	// Only add a status the text does not already open with, so the openai SDK's
	// "<status> status code (no body)" is not printed twice.
	return text.includes(String(norm.status)) ? text : `${norm.status}: ${text}`;
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

export function safeJsonStringify(value: unknown): string {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}
