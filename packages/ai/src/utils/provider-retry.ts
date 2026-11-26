import type { Api, Model, ProviderResponse } from "../types.ts";
import { headersToRecord } from "./headers.ts";

const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

interface ProviderRetryOptions<TModel = Model<Api>> {
	maxRetries?: number;
	maxRetryDelayMs?: number;
	signal?: AbortSignal;
	/** HTTP statuses that fail at once although the default policy would retry them. */
	noRetryStatuses?: readonly number[];
	/** Called for failed attempts with the request's model. See `retryProviderRequest`. */
	onErrorResponse?: (response: ProviderResponse, model: TModel) => void | Promise<void>;
}

interface ProviderError extends Error {
	status: number | undefined;
	headers: Headers | undefined;
}

function isProviderError(error: unknown): error is ProviderError {
	if (!(error instanceof Error) || !("status" in error) || !("headers" in error)) return false;
	return (
		(error.status === undefined || typeof error.status === "number") &&
		(error.headers === undefined || error.headers instanceof Headers)
	);
}

/** Mirrors the pinned OpenAI/Anthropic SDK retry policy; review when either SDK is upgraded. */
function isRetryableProviderError(error: ProviderError): boolean {
	const shouldRetry = error.headers?.get("x-should-retry");
	if (shouldRetry === "true") return true;
	if (shouldRetry === "false") return false;

	if (error.status === undefined) return true;
	return (
		error.status === 408 ||
		error.status === 409 ||
		error.status === 429 ||
		(typeof error.status === "number" && error.status >= 500)
	);
}

function validateServerRetryDelayMs(
	delayMs: number,
	maxRetryDelayMs: number | undefined,
	providerErrorMessage: string,
): number {
	const maxDelayMs = maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	if (maxDelayMs > 0 && delayMs > maxDelayMs) {
		throw new Error(
			`Server requested ${Math.ceil(delayMs / 1000)}s retry delay (max: ${Math.ceil(maxDelayMs / 1000)}s). ${providerErrorMessage}`,
		);
	}
	return delayMs;
}

function getRetryDelayMs(error: ProviderError, retryIndex: number, maxRetryDelayMs: number | undefined): number {
	const retryAfterMs = error.headers?.get("retry-after-ms");
	if (retryAfterMs) {
		const value = Number.parseFloat(retryAfterMs);
		if (Number.isFinite(value)) return validateServerRetryDelayMs(value, maxRetryDelayMs, error.message);
	}

	const retryAfter = error.headers?.get("retry-after");
	if (retryAfter) {
		const seconds = Number.parseFloat(retryAfter);
		const delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
		if (Number.isFinite(delayMs)) return validateServerRetryDelayMs(delayMs, maxRetryDelayMs, error.message);
	}

	const exponentialDelay = Math.min(0.5 * 2 ** retryIndex, 8) * 1000;
	return exponentialDelay * (1 - Math.random() * 0.25);
}

function createAbortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}

		const onAbort = () => {
			clearTimeout(timeout);
			reject(createAbortError());
		};
		const timeout = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function reportErrorResponse<TModel>(
	error: ProviderError,
	model: TModel | undefined,
	onErrorResponse: ((response: ProviderResponse, model: TModel) => void | Promise<void>) | undefined,
): Promise<void> {
	if (!onErrorResponse || model === undefined) return Promise.resolve();
	return Promise.resolve(
		onErrorResponse({ status: error.status ?? 0, headers: headersToRecord(error.headers ?? new Headers()) }, model),
	);
}

/**
 * Reproduce the retry behavior used by the OpenAI and Anthropic SDKs while making
 * their backoff sleep interruptible. Their built-in retry timers ignore the
 * request AbortSignal, so callers must invoke the SDK with `maxRetries: 0` and
 * wrap the request with this helper. Provider-requested delays above
 * `maxRetryDelayMs` fail immediately (60 seconds by default); set it to zero to
 * disable the limit.
 *
 * `onErrorResponse` reports failed attempts: consecutive failures with the same
 * status collapse to their last attempt, while a different status reports the
 * earlier attempt immediately. No report is made for a successful response.
 */
export async function retryProviderRequest<T, TModel = Model<Api>>(
	request: () => Promise<T>,
	options: ProviderRetryOptions<TModel> = {},
	model?: TModel,
): Promise<T> {
	const maxRetries = options.maxRetries ?? 0;
	let retriesRemaining = maxRetries;
	let pendingError: ProviderError | undefined;

	for (;;) {
		try {
			// Each retry is a fresh SDK request, so X-Stainless-Retry-Count remains zero.
			const result = await request();
			// Consecutive failures with the same status collapse into one report.
			if (pendingError && model !== undefined) {
				await reportErrorResponse(pendingError, model, options.onErrorResponse);
			}
			return result;
		} catch (error) {
			const currentError = isProviderError(error) ? error : undefined;

			// A status change ends the previous run: report its last attempt.
			if (pendingError && options.onErrorResponse && currentError?.status !== pendingError.status) {
				await reportErrorResponse(pendingError, model, options.onErrorResponse);
			}

			if (options.signal?.aborted) {
				if (currentError) await reportErrorResponse(currentError, model, options.onErrorResponse);
				throw createAbortError();
			}

			if (!currentError) {
				throw error;
			}
			pendingError = currentError;

			if (retriesRemaining <= 0 || !isRetryableProviderError(currentError)) {
				// Only the final attempt of a same-status run is reported.
				await reportErrorResponse(currentError, model, options.onErrorResponse);
				throw error;
			}
			if (currentError.status !== undefined && options.noRetryStatuses?.includes(currentError.status)) {
				await reportErrorResponse(currentError, model, options.onErrorResponse);
				throw error;
			}

			const retryIndex = maxRetries - retriesRemaining;
			retriesRemaining--;
			await abortableSleep(getRetryDelayMs(currentError, retryIndex, options.maxRetryDelayMs), options.signal);
		}
	}
}
