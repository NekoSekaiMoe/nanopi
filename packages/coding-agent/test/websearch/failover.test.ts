// Key rotation and failover behaviour of the engine chain, exercised with a
// stubbed fetch so no test reaches a real provider.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebsearchConfig } from "../../src/extras/websearch/src/config.ts";
import { splitKeys } from "../../src/extras/websearch/src/engines.ts";
import { orderChain, runSearch } from "../../src/extras/websearch/src/search.ts";

interface Call {
	url: string;
	headers: Record<string, string>;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const firecrawlOk = {
	success: true,
	data: { web: [{ title: "Node.js", url: "https://nodejs.org/en", description: "Run JavaScript" }] },
};
const keenableOk = {
	results: [{ title: "Keenable hit", url: "https://example.com/a", snippet: "snippet text" }],
};

let dir: string;
let cooldownPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "websearch-test-"));
	cooldownPath = join(dir, "state.json");
});

afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

function config(overrides: WebsearchConfig = {}): WebsearchConfig {
	return { timeoutMs: 2_000, deadlineMs: 5_000, ...overrides };
}

describe("splitKeys", () => {
	it("splits on commas and trims, dropping empty entries", () => {
		expect(splitKeys("a, b ,, c ")).toEqual(["a", "b", "c"]);
	});

	it("returns nothing for an empty value", () => {
		expect(splitKeys("")).toEqual([]);
	});
});

describe("runSearch failover", () => {
	it("answers from the keyless Firecrawl channel with no key configured", async () => {
		const calls: Call[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			calls.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string> });
			return jsonResponse(firecrawlOk);
		});

		const outcome = await runSearch("node lts", { config: config(), cooldownPath });
		expect(outcome.engine).toBe("firecrawl");
		expect(outcome.items).toHaveLength(1);
		expect(outcome.items[0]?.source).toBe("nodejs.org");
		expect(calls[0]?.headers.authorization).toBeUndefined();
	});

	it("moves to the next engine when the first one fails", async () => {
		vi.stubGlobal("fetch", async (url: string) => {
			if (String(url).includes("firecrawl")) return jsonResponse({ error: "boom" }, 500);
			return jsonResponse(keenableOk);
		});

		const outcome = await runSearch("node lts", { config: config(), cooldownPath });
		expect(outcome.engine).toBe("keenable");
		expect(outcome.attempts.map((attempt) => attempt.ok)).toEqual([false, true]);
		expect(outcome.attempts[0]?.error).toContain("500");
	});

	it("rotates to the second key of the same engine before failing over", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			if (!String(url).includes("firecrawl")) return jsonResponse(keenableOk);
			const auth = (init.headers as Record<string, string>).authorization ?? "";
			seen.push(auth);
			if (auth === "Bearer first-key") return jsonResponse({ error: "unauthorized" }, 401);
			return jsonResponse(firecrawlOk);
		});

		const outcome = await runSearch("node lts", {
			config: config({ firecrawl: { apiKey: "first-key,second-key" } }),
			cooldownPath,
		});
		expect(seen).toEqual(["Bearer first-key", "Bearer second-key"]);
		expect(outcome.engine).toBe("firecrawl");
		expect(outcome.keyIndex).toBe(2);
		expect(outcome.attempts[0]).toMatchObject({ engine: "firecrawl", keyIndex: 1, ok: false });
	});

	it("does not burn a key on a server error, moving straight to the next engine", async () => {
		const seen: string[] = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			const label = String(url);
			if (label.includes("firecrawl")) {
				seen.push(`firecrawl:${(init.headers as Record<string, string>).authorization ?? "keyless"}`);
				return jsonResponse({ error: "upstream down" }, 500);
			}
			seen.push("keenable");
			return jsonResponse(keenableOk);
		});

		// The failing engine carries two keys: a 5xx must fail over, not rotate,
		// so its second key is never used and the next engine answers instead.
		const outcome = await runSearch("node lts", {
			config: config({ firecrawl: { apiKey: "one,two" } }),
			cooldownPath,
		});
		expect(seen).toEqual(["firecrawl:Bearer one", "keenable"]);
		expect(outcome.engine).toBe("keenable");
	});

	it("cools a spent key down and tries the healthy engine first on the next call", async () => {
		let firecrawlCalls = 0;
		vi.stubGlobal("fetch", async (url: string) => {
			if (String(url).includes("firecrawl")) {
				firecrawlCalls += 1;
				return jsonResponse({ error: "quota exceeded, out of credits" }, 402);
			}
			return jsonResponse(keenableOk);
		});

		await runSearch("first", { config: config(), cooldownPath });
		expect(firecrawlCalls).toBe(1);
		expect(JSON.parse(readFileSync(cooldownPath, "utf-8"))).toHaveProperty("firecrawl");

		const second = await runSearch("second", { config: config(), cooldownPath });
		expect(second.engine).toBe("keenable");
		// The cooled engine is tried last, so the healthy one answering means it is never touched.
		expect(firecrawlCalls).toBe(1);
	});

	it("reports every attempt when nothing answers", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ error: "nope" }, 503));
		await expect(runSearch("nothing", { config: config(), cooldownPath })).rejects.toThrow(
			/No engine answered\. Tried: firecrawl: firecrawl returned 503.*; keenable: keenable returned 503.*; tavily: no API key configured/,
		);
	});

	it("rejects an empty query", async () => {
		await expect(runSearch("   ", { config: config(), cooldownPath })).rejects.toThrow(/non-empty query/);
	});
});

describe("orderChain", () => {
	it("keeps config order apart from cooled engines, which go last", () => {
		writeFileSync(cooldownPath, JSON.stringify({ firecrawl: { until: Date.now() + 60_000, reason: "quota" } }));
		expect(
			orderChain(["firecrawl", "keenable", "tavily"], { firecrawl: { until: Date.now() + 60_000, reason: "" } }),
		).toEqual(["keenable", "tavily", "firecrawl"]);
	});

	it("returns the chain unchanged when nothing is cooling", () => {
		expect(orderChain(["firecrawl", "keenable"], {})).toEqual(["firecrawl", "keenable"]);
	});
});
