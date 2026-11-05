import { describe, expect, it } from "vitest";
import { modelsMatch, readEchoedModel } from "../src/core/model-identity.ts";

describe("readEchoedModel", () => {
	it("reads the model an OpenAI-compatible endpoint echoed", () => {
		expect(readEchoedModel({ "openai-model": "gpt-5.3-codex" })).toEqual({
			id: "gpt-5.3-codex",
			header: "openai-model",
		});
	});

	it("matches header names case-insensitively", () => {
		expect(readEchoedModel({ "OpenAI-Model": "gpt-5.3-codex" })?.id).toBe("gpt-5.3-codex");
	});

	it("ignores empty values and falls through to the next header", () => {
		expect(readEchoedModel({ "openai-model": "  ", "x-model": "claude-opus-4-5" })).toEqual({
			id: "claude-opus-4-5",
			header: "x-model",
		});
	});

	it("returns undefined when no header names a model", () => {
		expect(readEchoedModel({ "x-request-id": "req-1" })).toBeUndefined();
	});
});

describe("modelsMatch", () => {
	it("treats a vendor prefix as the same model", () => {
		expect(modelsMatch("openai/gpt-5.3-codex", "gpt-5.3-codex")).toBe(true);
	});

	it("treats a dated suffix as the same model", () => {
		expect(modelsMatch("claude-opus-4-5", "claude-opus-4-5-20251101")).toBe(true);
	});

	it("ignores a relay's variant suffix", () => {
		expect(modelsMatch("glm-4.6", "glm-4.6:free")).toBe(true);
	});

	it("reports a different model as a mismatch", () => {
		expect(modelsMatch("gpt-5.3-codex", "gpt-4o-mini")).toBe(false);
	});

	it("does not treat a shared prefix as the same model", () => {
		expect(modelsMatch("gpt-5", "gpt-5-mini")).toBe(false);
	});
});
