import { describe, expect, it } from "vitest";
import { resolveCatalogBaseUrl } from "../scripts/model-data.ts";

describe("resolveCatalogBaseUrl", () => {
	it("ships the route the gateway publishes for the model", () => {
		// models.dev's `provider.api` for Zen models; the Anthropic SDK appends
		// `/v1/messages` itself, so its base URL stops at the family root.
		expect(
			resolveCatalogBaseUrl(
				"anthropic-messages",
				"https://opencode.ai/inference",
				"https://opencode.ai/inference/anthropic/v1",
				true,
			),
		).toBe("https://opencode.ai/inference/anthropic");
		expect(
			resolveCatalogBaseUrl(
				"openai-completions",
				"https://opencode.ai/inference/v1",
				"https://opencode.ai/inference/openai/v1",
				true,
			),
		).toBe("https://opencode.ai/inference/openai/v1");
		expect(
			resolveCatalogBaseUrl(
				"google-generative-ai",
				"https://opencode.ai/inference/go/v1",
				"https://opencode.ai/inference/go/google/v1beta",
				true,
			),
		).toBe("https://opencode.ai/inference/go/google/v1beta");
		expect(
			resolveCatalogBaseUrl(
				"anthropic-messages",
				"https://opencode.ai/inference/go",
				"https://opencode.ai/inference/go/anthropic/v1",
				true,
			),
		).toBe("https://opencode.ai/inference/go/anthropic");
	});

	it("adds the openai family segment when the catalog has no per-model route", () => {
		// Chat completions and Responses share `<root>/openai/v1`.
		expect(resolveCatalogBaseUrl("openai-completions", "https://opencode.ai/inference/v1", undefined, true)).toBe(
			"https://opencode.ai/inference/openai/v1",
		);
		expect(resolveCatalogBaseUrl("openai-responses", "https://opencode.ai/inference/v1", undefined, true)).toBe(
			"https://opencode.ai/inference/openai/v1",
		);
		// An Anthropic base URL already ends at the family route.
		expect(resolveCatalogBaseUrl("anthropic-messages", "https://opencode.ai/inference", undefined, true)).toBe(
			"https://opencode.ai/inference",
		);
	});

	it("leaves a lane that does not route per family alone", () => {
		expect(resolveCatalogBaseUrl("openai-completions", "https://opencode.ai/zen/v1", undefined, false)).toBe(
			"https://opencode.ai/zen/v1",
		);
		expect(resolveCatalogBaseUrl("anthropic-messages", "https://opencode.ai/zen", undefined, false)).toBe(
			"https://opencode.ai/zen",
		);
	});
});
