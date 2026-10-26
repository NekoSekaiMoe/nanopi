import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchModelListing, modelListingUrls, parseModelListing } from "../src/core/model-listing.ts";

const original = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = original;
});

function listing(ids: string[]): Response {
	return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
}

describe("parseModelListing", () => {
	it("reads OpenAI-style data[].id and Google-style models[].name", () => {
		expect(parseModelListing({ data: [{ id: "deepseek-chat" }] })).toEqual([{ id: "deepseek-chat" }]);
		expect(parseModelListing({ models: [{ name: "gemini-2.5-pro" }] })).toEqual([{ id: "gemini-2.5-pro" }]);
	});

	it("keeps display names and drops duplicates", () => {
		expect(parseModelListing({ data: [{ id: "a", display_name: "A" }, { id: "a" }, { nope: 1 }] })).toEqual([
			{ id: "a", name: "A" },
		]);
	});

	it("returns nothing for a payload without a list", () => {
		expect(parseModelListing({ error: "nope" })).toEqual([]);
		expect(parseModelListing(null)).toEqual([]);
	});
});

describe("modelListingUrls", () => {
	it("tries the base first and the /v1 sibling second for an OpenAI-compatible endpoint", () => {
		expect(modelListingUrls("https://gw.example", "openai")).toEqual([
			"https://gw.example/models",
			"https://gw.example/v1/models",
		]);
		expect(modelListingUrls("https://gw.example/v1/", "openai")).toEqual([
			"https://gw.example/v1/models",
			"https://gw.example/v1/models",
		]);
	});

	it("puts /v1 first for an Anthropic-shaped endpoint", () => {
		expect(modelListingUrls("https://gw.example", "anthropic")).toEqual([
			"https://gw.example/v1/models",
			"https://gw.example/models",
		]);
	});
});

describe("fetchModelListing", () => {
	it("falls back to /v1/models when the bare base has no listing", async () => {
		const asked: string[] = [];
		globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			asked.push(url);
			return url.endsWith("/v1/models") ? listing(["gw-model"]) : new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		expect(await fetchModelListing({ baseUrl: "https://gw.example" })).toEqual([{ id: "gw-model" }]);
		expect(asked).toEqual(["https://gw.example/models", "https://gw.example/v1/models"]);
	});

	it("carries the key in the header the protocol expects", async () => {
		const seen: Array<Record<string, string>> = [];
		globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			seen.push((init?.headers ?? {}) as Record<string, string>);
			return listing(["a"]);
		}) as unknown as typeof fetch;

		await fetchModelListing({ baseUrl: "https://gw.example", type: "openai", apiKey: "sk-1" });
		await fetchModelListing({ baseUrl: "https://gw.example", type: "anthropic", apiKey: "sk-2" });

		expect(seen[0]?.Authorization).toBe("Bearer sk-1");
		expect(seen[1]?.["x-api-key"]).toBe("sk-2");
		expect(seen[1]?.["anthropic-version"]).toBe("2023-06-01");
	});

	it("reports the first rejection when every candidate path fails", async () => {
		globalThis.fetch = vi.fn(async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
		await expect(fetchModelListing({ baseUrl: "https://gw.example" })).rejects.toThrow(/answered 401/);
	});
});
