import { describe, expect, test } from "vitest";
import { bearerTokenMatches } from "../src/modes/webui/webui-server.ts";

describe("webui bearerTokenMatches", () => {
	const token = "a".repeat(48);

	test("accepts the exact bearer token", () => {
		expect(bearerTokenMatches(token, `Bearer ${token}`)).toBe(true);
	});

	test("rejects wrong token, missing header, and non-bearer schemes", () => {
		expect(bearerTokenMatches(token, `Bearer ${"b".repeat(48)}`)).toBe(false);
		expect(bearerTokenMatches(token, undefined)).toBe(false);
		expect(bearerTokenMatches(token, token)).toBe(false);
		expect(bearerTokenMatches(token, `Basic ${token}`)).toBe(false);
	});

	test("rejects length-mismatched tokens without throwing", () => {
		// timingSafeEqual throws on length mismatch; the helper must guard it.
		expect(bearerTokenMatches(token, "Bearer short")).toBe(false);
		expect(bearerTokenMatches("short", `Bearer ${token}`)).toBe(false);
	});
});

import { describeProviderError } from "../src/modes/webui/webui-server.ts";

describe("describeProviderError", () => {
	test("keeps the provider status as a numeric code", () => {
		expect(describeProviderError("401: invalid api key")).toEqual({
			message: "invalid api key",
			code: 401,
		});
		expect(describeProviderError("OpenAI (429): rate limited")).toEqual({
			message: "rate limited",
			code: 429,
		});
	});

	test("leaves messages without a status untouched", () => {
		expect(describeProviderError("socket hang up")).toEqual({ message: "socket hang up" });
		expect(describeProviderError(undefined).code).toBeUndefined();
	});
});
