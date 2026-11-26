import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryModelsStore } from "@nanopi/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { clearConfigValueCache } from "../src/core/resolve-config-value.ts";

// Regression for upstream #12164 / issue #816: a stored `!command` that fails to resolve
// must not be reported the same as one that resolves to a usable key.

const tempDir = join(tmpdir(), `nanopi-test-stored-command-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const model = {
	id: "m",
	name: "m",
	api: "openai-completions",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
};

async function createRuntime(command: string): Promise<ModelRuntime> {
	const modelsPath = join(tempDir, "models.json");
	writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				"custom-provider": { baseUrl: "http://x", api: "openai-completions", models: [model] },
			},
		}),
	);
	return ModelRuntime.create({
		credentials: AuthStorage.inMemory({ "custom-provider": { type: "api_key", key: command } }),
		modelsPath,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
	});
}

describe("stored !command credential auth status", () => {
	beforeEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		mkdirSync(tempDir, { recursive: true });
		clearConfigValueCache();
	});

	afterEach(() => {
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true });
		clearConfigValueCache();
	});

	test("reports a stored command that resolves as configured", async () => {
		const runtime = await createRuntime("!printf resolved-key");

		expect(runtime.getProviderAuthStatus("custom-provider")).toEqual({ configured: true, source: "stored" });
		expect(await runtime.checkAuth("custom-provider")).toEqual({
			type: "api_key",
			source: "stored credential",
		});
		expect((await runtime.getAuth("custom-provider"))?.auth.apiKey).toBe("resolved-key");
	});

	test("reports a stored command that fails to resolve as recorded but unresolved", async () => {
		const runtime = await createRuntime("!printf ''");

		expect(runtime.getProviderAuthStatus("custom-provider")).toEqual({
			configured: false,
			source: "stored",
			unresolved: true,
		});
		expect(await runtime.checkAuth("custom-provider")).toBeUndefined();
		expect(await runtime.getAuth("custom-provider")).toBeUndefined();
	});
});
