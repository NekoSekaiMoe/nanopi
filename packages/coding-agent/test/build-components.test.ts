import { describe, expect, it } from "vitest";
import {
	buildToolset,
	builtinProviderIds,
	enabledOAuthFlows,
	hasOAuthFlows,
	isBashOnlyBuild,
	isNoBuiltinProviderBuild,
	isOAuthFlowEnabled,
	isProviderIncluded,
	isShellToolName,
} from "../src/build-components.ts";

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

// Outside a flavored bundle every component is enabled, so the OAuth helpers
// report the full registry. This catches a flow id that drifts from
// scripts/oauth-flows.mjs: an unknown id would read as enabled here and as
// disabled in a bundle.
describe("oauth flows outside a flavored bundle", () => {
	it("lists every registry flow", () => {
		expect(enabledOAuthFlows()).toEqual([
			"anthropic",
			"antigravity",
			"github-copilot",
			"kimi-coding",
			"meta",
			"openai-chatgpt",
			"openai-codex",
			"openrouter",
			"xai",
		]);
		expect(hasOAuthFlows()).toBe(true);
		expect(isOAuthFlowEnabled("github-copilot")).toBe(true);
		expect(isOAuthFlowEnabled("not-a-flow")).toBe(true);
	});
});

// Outside a bundle the toolset names nothing, so the shell-only predicates stay
// false: a source checkout ships every tool. The flavors themselves are covered
// by scripts/buildconfig.test.mjs and the single-file build.
describe("shell-only predicates outside a flavored bundle", () => {
	it("does not claim a shell-only build", () => {
		expect(buildToolset()).toBeUndefined();
		expect(isBashOnlyBuild()).toBe(false);
	});

	it("knows the shell tool names", () => {
		expect(isShellToolName("bash")).toBe(true);
		expect(isShellToolName("powershell")).toBe(true);
		expect(isShellToolName("read")).toBe(false);
	});
});
