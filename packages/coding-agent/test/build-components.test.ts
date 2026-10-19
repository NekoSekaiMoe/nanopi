import { describe, expect, it } from "vitest";
import { builtinProviderIds, isNoBuiltinProviderBuild, isProviderIncluded } from "../src/build-components.ts";

// The build defines are absent outside a flavored bundle (source checkouts, npm
// installs), which is the only state this test can observe.
describe("isProviderIncluded", () => {
	it("ships every provider when the build defined no provider set", () => {
		expect(builtinProviderIds()).toBeUndefined();
		expect(isProviderIncluded("openai")).toBe(true);
		expect(isProviderIncluded("some-vendor-without-a-catalog")).toBe(true);
		expect(isNoBuiltinProviderBuild()).toBe(false);
	});
});
