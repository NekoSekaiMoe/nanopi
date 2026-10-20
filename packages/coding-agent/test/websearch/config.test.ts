// Config resolution: file layer, env fallback, and the enabled switch.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_ENGINE_CHAIN,
	engineChain,
	engineKeyValue,
	loadWebsearchConfig,
} from "../../src/extras/websearch/src/config.ts";
import { enginesForRole } from "../../src/extras/websearch/src/engines.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "websearch-config-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeConfig(value: unknown): string {
	const path = join(dir, "websearch.json");
	writeFileSync(path, JSON.stringify(value));
	return path;
}

describe("loadWebsearchConfig", () => {
	it("reads an empty config when the file is missing", () => {
		expect(loadWebsearchConfig(join(dir, "absent.json"))).toEqual({});
	});

	it("reads an empty config from a malformed file instead of failing", () => {
		const path = join(dir, "broken.json");
		writeFileSync(path, "{ not json");
		expect(loadWebsearchConfig(path)).toEqual({});
	});

	it("keeps only known engine ids and drops junk entries", () => {
		const config = loadWebsearchConfig(
			writeConfig({
				engines: ["tavily", "nope", 7],
				tavily: { apiKey: "k", baseUrl: "https://proxy.example" },
				unknown: { apiKey: "x" },
				timeoutMs: 5_000,
			}),
		);
		expect(config.engines).toEqual(["tavily"]);
		expect(config.tavily).toEqual({ apiKey: "k", baseUrl: "https://proxy.example" });
		expect(Object.keys(config)).not.toContain("unknown");
		expect(config.timeoutMs).toBe(5_000);
	});

	it("treats an engine set to false as disabled", () => {
		const config = loadWebsearchConfig(writeConfig({ firecrawl: false }));
		expect(config.firecrawl).toEqual({ enabled: false });
	});
});

describe("engineChain", () => {
	it("defaults to the keyless-first chain", () => {
		expect(engineChain({})).toEqual([...DEFAULT_ENGINE_CHAIN]);
	});

	it("drops engines switched off in the file", () => {
		const config = loadWebsearchConfig(writeConfig({ firecrawl: { enabled: false } }));
		expect(engineChain(config)).toEqual(["keenable", "tavily", "exa"]);
	});
});

describe("engineKeyValue", () => {
	it("prefers the config file over the environment", () => {
		const config = loadWebsearchConfig(writeConfig({ tavily: { apiKey: "from-file" } }));
		expect(engineKeyValue(config, "tavily", { TAVILY_API_KEY: "from-env" })).toBe("from-file");
	});

	it("falls back to the environment variable", () => {
		expect(engineKeyValue({}, "exa", { EXA_API_KEY: "from-env" })).toBe("from-env");
	});

	it("resolves an $ENV reference inside the configured value", () => {
		const config = loadWebsearchConfig(writeConfig({ tavily: { apiKey: "$MY_TAVILY" } }));
		expect(engineKeyValue(config, "tavily", { MY_TAVILY: "resolved" })).toBe("resolved");
	});
});

describe("enginesForRole", () => {
	it("keeps only engines that can fetch", () => {
		expect(enginesForRole(["firecrawl", "keenable", "tavily", "exa"], "fetch")).toEqual(["firecrawl"]);
	});

	it("keeps every search engine in chain order", () => {
		expect(enginesForRole(["exa", "firecrawl"], "search")).toEqual(["exa", "firecrawl"]);
	});
});
