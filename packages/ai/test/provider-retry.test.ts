import { afterEach, describe, expect, it, vi } from "vitest";
import { retryProviderRequest } from "../src/utils/provider-retry.ts";

function providerError(status: number | undefined, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`Provider error: ${status}`), {
		status,
		headers: new Headers(headers),
	});
}

describe("provider request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries retryable provider errors", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after-ms": "1000" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry errors the provider marks as non-retryable", async () => {
		const error = providerError(429, { "x-should-retry": "false" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2 })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry statuses listed in noRetryStatuses", async () => {
		const error = providerError(504, { "retry-after-ms": "0" });
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);

		await expect(retryProviderRequest(request, { maxRetries: 2, noRetryStatuses: [504] })).rejects.toBe(error);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("rejects a provider-requested retry delay above the limit", async () => {
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		await expect(retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 1000 })).rejects.toThrow(
			"Server requested 277403s retry delay (max: 1s)",
		);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("allows disabling the provider-requested retry delay cap", async () => {
		vi.useFakeTimers();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "retry-after": "2" }))
			.mockResolvedValue("ok");

		const result = retryProviderRequest(request, { maxRetries: 1, maxRetryDelayMs: 0 });
		await vi.advanceTimersByTimeAsync(1999);
		expect(request).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toBe("ok");
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("aborts a provider-requested retry delay", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(providerError(429, { "retry-after": "277403" }));

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal });
		await vi.advanceTimersByTimeAsync(0);
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(request).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("failed response reporting", () => {
	function instantError(status: number): Error {
		return providerError(status, { "retry-after-ms": "0" });
	}

	it("reports only the last failure when consecutive attempts share a status", async () => {
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(instantError(429))
			.mockRejectedValueOnce(instantError(429))
			.mockResolvedValue("ok");
		const onErrorResponse = vi.fn();

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, onErrorResponse }, {
			id: "test-model",
		} as never);

		await expect(result).resolves.toBe("ok");
		expect(onErrorResponse).toHaveBeenCalledTimes(1);
		expect(onErrorResponse.mock.calls[0][0].status).toBe(429);
		expect(onErrorResponse.mock.calls[0][1]).toEqual({ id: "test-model" });
	});

	it("reports the latest failure per status when a status repeats later in the sequence", async () => {
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(instantError(429))
			.mockRejectedValueOnce(instantError(429))
			.mockRejectedValueOnce(instantError(503))
			.mockRejectedValueOnce(instantError(429))
			.mockResolvedValue("ok");
		const onErrorResponse = vi.fn();

		const result = retryProviderRequest(request, { maxRetries: 4, maxRetryDelayMs: 0, onErrorResponse }, {
			id: "test-model",
		} as never);

		await expect(result).resolves.toBe("ok");
		expect(onErrorResponse).toHaveBeenCalledTimes(2);
		expect(onErrorResponse.mock.calls.map(([response]) => response.status)).toEqual([429, 503]);
	});

	it("keeps the latest headers for each status", async () => {
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(providerError(429, { "x-attempt": "first" }))
			.mockRejectedValueOnce(providerError(429, { "x-attempt": "last" }))
			.mockResolvedValue("ok");
		const onErrorResponse = vi.fn();

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, onErrorResponse }, {
			id: "test-model",
		} as never);

		await expect(result).resolves.toBe("ok");
		expect(onErrorResponse).toHaveBeenCalledTimes(1);
		expect(onErrorResponse.mock.calls[0][0].headers["x-attempt"]).toBe("last");
	});

	it("reports the final failure when all retries are exhausted", async () => {
		const error = instantError(503);
		const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);
		const onErrorResponse = vi.fn();

		const result = retryProviderRequest(request, { maxRetries: 2, maxRetryDelayMs: 0, onErrorResponse }, {
			id: "test-model",
		} as never);

		await expect(result).rejects.toBe(error);
		expect(onErrorResponse).toHaveBeenCalledTimes(1);
		expect(onErrorResponse.mock.calls[0][0].status).toBe(503);
	});

	it("reports a provider failure even when the backoff is aborted", async () => {
		const controller = new AbortController();
		const request = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(instantError(429))
			.mockImplementation(() => {
				controller.abort();
				return Promise.reject(instantError(429));
			});
		const onErrorResponse = vi.fn();

		const result = retryProviderRequest(
			request,
			{ maxRetries: 2, maxRetryDelayMs: 0, signal: controller.signal, onErrorResponse },
			{ id: "test-model" } as never,
		);

		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(onErrorResponse).toHaveBeenCalledTimes(1);
		expect(onErrorResponse.mock.calls[0][0].status).toBe(429);
	});
});
