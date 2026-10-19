import type { Model } from "@nanopi/pi-ai";
import { describe, expect, it } from "vitest";
import { mergeModelLists, modelsWithinAllowlist } from "../src/modes/webui/model-list.ts";

function model(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

const catalog = [
	model("anthropic", "claude-sonnet-4"),
	model("anthropic", "claude-opus-4"),
	model("deepseek", "deepseek-chat"),
];

describe("modelsWithinAllowlist", () => {
	// Regression for #84: the webui listed the whole catalog while the CLI
	// honoured enabledModels, so the browser offered models /model could not pick.
	it("keeps only the rows a pattern list selects", () => {
		expect(modelsWithinAllowlist(catalog, ["anthropic/*"], undefined).map((entry) => entry.id)).toEqual([
			"claude-sonnet-4",
			"claude-opus-4",
		]);
	});

	it("matches a bare model id like the CLI does", () => {
		expect(modelsWithinAllowlist(catalog, ["deepseek-chat"], undefined).map((entry) => entry.provider)).toEqual([
			"deepseek",
		]);
	});

	it("returns the whole catalog when no allowlist is configured", () => {
		expect(modelsWithinAllowlist(catalog, undefined, undefined)).toHaveLength(3);
		expect(modelsWithinAllowlist(catalog, [], undefined)).toHaveLength(3);
	});

	it("drops the active model from the picker only when it matches the allowlist", () => {
		const active = model("deepseek", "deepseek-chat");
		const subset = modelsWithinAllowlist(catalog, ["anthropic/*"], active);
		expect(subset.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
			"deepseek/deepseek-chat",
			"anthropic/claude-sonnet-4",
			"anthropic/claude-opus-4",
		]);
	});

	it("keeps the active model out of the list when it is already selected", () => {
		const active = model("anthropic", "claude-opus-4");
		expect(modelsWithinAllowlist(catalog, ["anthropic/*"], active).map((entry) => entry.id)).toEqual([
			"claude-sonnet-4",
			"claude-opus-4",
		]);
	});
});

describe("mergeModelLists", () => {
	it("dedupes by provider/id and skips non-chat models", () => {
		const models: Model<any>[] = [model("anthropic", "claude-sonnet-4")];
		mergeModelLists(models, [model("anthropic", "claude-sonnet-4"), undefined]);
		expect(models).toHaveLength(1);
	});
});
