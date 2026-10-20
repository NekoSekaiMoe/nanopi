import { describe, expect, it } from "vitest";
import {
	builtinApiIds,
	builtinProviderIds,
	builtinToolNames,
	formatIncludedApis,
	isApiIncluded,
} from "../src/build-components.ts";

// The build defines are absent outside a flavored bundle (source checkouts, npm
// installs), which is the only state this test can observe. The bundle itself is
// covered by the build smoke test.
describe("build components outside a flavored bundle", () => {
	it("carries every tool when the build names no tool set", () => {
		expect(builtinToolNames()).toBeUndefined();
	});

	it("registers every API when the build names no API set", () => {
		expect(builtinApiIds()).toBeUndefined();
		expect(isApiIncluded("openai-completions")).toBe(true);
		expect(isApiIncluded("anthropic-messages")).toBe(true);
		expect(formatIncludedApis()).toBe("every built-in API");
	});

	it("keeps every provider catalog", () => {
		expect(builtinProviderIds()).toBeUndefined();
	});
});
