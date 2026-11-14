import { describe, expect, it } from "vitest";
import { hostnameOf, matchesHostname } from "../src/utils/endpoint.ts";

// Provider detection used `baseUrl.includes("<host>")`, so a host that merely
// embedded the string, or any URL whose PATH contained it, inherited another
// provider's request shape and attribution headers (CodeQL).
describe("matchesHostname", () => {
	it("matches the host itself and its subdomains", () => {
		expect(matchesHostname("https://api.openai.com/v1", "api.openai.com")).toBe(true);
		expect(matchesHostname("https://api.openai.com/", "openai.com")).toBe(true);
		expect(matchesHostname("https://eu.api.openai.com/v1", "api.openai.com")).toBe(true);
		expect(matchesHostname("https://API.OpenAI.com/v1", "api.openai.com")).toBe(true);
	});

	it("rejects a host that only embeds the expected name", () => {
		expect(matchesHostname("https://api.openai.com.evil.tld/v1", "api.openai.com")).toBe(false);
		expect(matchesHostname("https://evilopenrouter.ai/api", "openrouter.ai")).toBe(false);
	});

	it("rejects a host that only carries the expected name in its path or query", () => {
		expect(matchesHostname("https://proxy.example.com/?to=api.openai.com", "api.openai.com")).toBe(false);
		expect(matchesHostname("https://proxy.example.com/openrouter.ai/v1", "openrouter.ai")).toBe(false);
	});

	it("rejects an unparseable baseUrl", () => {
		expect(matchesHostname("not a url", "openrouter.ai")).toBe(false);
		expect(matchesHostname("", "openrouter.ai")).toBe(false);
	});

	it("reads the hostname of a parseable baseUrl", () => {
		expect(hostnameOf("https://API.OpenAI.com/v1")).toBe("api.openai.com");
		expect(hostnameOf("nope")).toBeUndefined();
	});
});
