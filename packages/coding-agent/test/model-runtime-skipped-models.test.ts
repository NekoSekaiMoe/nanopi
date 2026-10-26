import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider, createSkippedApiModels } from "../src/core/provider-composer.ts";

// A source checkout carries every API, so the build define that drops them is
// absent. Narrow it here to the `minimal` flavor's set (buildconfig.json
// `apiSets.openai`) so the drop path is reachable at all.
vi.mock("../src/build-components.ts", async (importOriginal) => {
	const actual = await (importOriginal as () => Promise<Record<string, unknown>>)();
	return {
		...actual,
		builtinApiIds: () => ["openai-completions"],
		isApiIncluded: (api: string) => api === "openai-completions",
		formatIncludedApis: () => "openai-completions",
	};
});

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write one models.json and load it the way ModelRuntime does. */
async function loadConfig(providers: Record<string, unknown>): Promise<ModelConfig> {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-skipped-models-"));
	dirs.push(dir);
	const path = join(dir, "models.json");
	writeFileSync(path, JSON.stringify({ providers }));
	return ModelConfig.load(path);
}

it("keeps the provider when a model names an api this build does not carry", async () => {
	const config = await loadConfig({
		nvidia: {
			api: "openai-completions",
			baseUrl: "https://integrate.api.nvidia.com/v1",
			apiKey: "k",
			// What a models.json written for the `full` flavor looks like in a build
			// that only ships openai-completions.
			models: [{ id: "deepseek-ai/deepseek-v4-flash-0731", api: "openai-responses" }, { id: "kept" }],
		},
	});
	const skipped = createSkippedApiModels();

	const provider = composeModelProvider("nvidia", undefined, config, undefined, skipped);
	expect(provider.getModels().map((model) => model.id)).toEqual(["kept"]);

	const messages = [...skipped.byProvider().values()].flat();
	expect(messages).toHaveLength(1);
	expect(messages[0]).toContain("deepseek-ai/deepseek-v4-flash-0731");
	expect(messages[0]).toContain('api "openai-responses" is not included in this build');
	expect(messages[0]).toContain("the model is ignored");
});

it("reports every skipped model of a provider", async () => {
	const config = await loadConfig({
		pm: {
			api: "openai-completions",
			baseUrl: "https://example.test/v1",
			apiKey: "k",
			models: [
				{ id: "a", api: "openai-responses" },
				{ id: "b", api: "anthropic-messages" },
				{ id: "c" },
				{ id: "d" },
			],
		},
	});
	const skipped = createSkippedApiModels();

	const provider = composeModelProvider("pm", undefined, config, undefined, skipped);
	expect(provider.getModels().map((model) => model.id)).toEqual(["c", "d"]);
	expect([...skipped.byProvider().values()].flat()).toHaveLength(2);
});

it("drops the whole provider when its own api is the missing one", async () => {
	const config = await loadConfig({
		pm: { api: "openai-responses", baseUrl: "https://example.test/v1", apiKey: "k", models: [{ id: "gpt-5.4" }] },
	});

	// Every model inherits the provider api, so there is nothing to keep. The
	// provider is dropped as an error, which ModelRuntime reports.
	expect(() => composeModelProvider("pm", undefined, config, undefined, createSkippedApiModels())).toThrow(
		'Provider pm: api "openai-responses" is not included in this build (included: openai-completions)',
	);
});

it("reports skipped models through the runtime warning, not the error", async () => {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-skipped-runtime-"));
	dirs.push(dir);
	const path = join(dir, "models.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				nvidia: {
					api: "openai-completions",
					baseUrl: "https://integrate.api.nvidia.com/v1",
					apiKey: "k",
					models: [{ id: "deepseek-v4", api: "openai-responses" }, { id: "kept" }],
				},
			},
		}),
	);
	const { AuthStorage } = await import("../src/core/auth-storage.ts");
	const { ModelRuntime } = await import("../src/core/model-runtime.ts");
	const { InMemoryCodingAgentModelsStore } = await import("../src/core/models-store.ts");

	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: path,
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: false,
	});

	expect(runtime.getError()).toBeUndefined();
	const warnings = runtime.getWarnings();
	expect(warnings).toContain("models.json: provider nvidia, model deepseek-v4");
	expect(warnings).toContain("the model is ignored");
	expect(runtime.getModel("nvidia", "kept")).toBeDefined();
	expect(runtime.getModel("nvidia", "deepseek-v4")).toBeUndefined();
});
