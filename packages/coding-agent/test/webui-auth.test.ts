import { describe, expect, test } from "vitest";
import { bearerTokenMatches, describeProviderError, reasoningEffortOf } from "../src/modes/webui/webui-server.ts";

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

describe("webui reasoningEffortOf", () => {
	const session = { provider: "anthropic", id: "claude-haiku-5-5" };
	const stored = (provider: string, id: string) =>
		provider === "anthropic" && id === "claude-haiku-5-5" ? "low" : undefined;

	// Issue #82: the sheet writes through setThinkingLevel (transcript), so
	// reading the per-model setting reported the level from before the pick.
	test("reports the live session level for the active model", () => {
		expect(reasoningEffortOf(session, session, "high", stored)).toBe("high");
	});

	test("falls back to the stored setting for other models", () => {
		expect(reasoningEffortOf(session, { provider: "google", id: "gemini-3-flash" }, "high", stored)).toBe("low");
		expect(reasoningEffortOf(session, undefined, "high", stored)).toBe("low");
	});

	test("stays undefined when nothing was ever picked", () => {
		expect(reasoningEffortOf({ provider: "x", id: "y" }, session, "high", stored)).toBeUndefined();
	});
});
