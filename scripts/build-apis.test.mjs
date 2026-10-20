import { strictEqual, throws } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createApiStubPlugin, readApiModuleIds, readProviderModuleIds, validateStubs } from "./build-apis.mjs";

let tempDirs = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-api-stubs-test-"));
	tempDirs.push(dir);
	return dir;
}

/** A minimal packages/ai tree: one API wrapper, one shard, and their stand-ins. */
function fixture({ apiStubExports = "export const exampleApi = () => {};", withProviderStub = true } = {}) {
	const aiDir = tempDir();
	for (const dir of ["src/api", "src/api/disabled", "src/providers", "src/providers/disabled"]) {
		mkdirSync(join(aiDir, dir), { recursive: true });
	}
	writeFileSync(join(aiDir, "src/api/example.lazy.ts"), "export const exampleApi = () => {};\n");
	writeFileSync(join(aiDir, "src/api/disabled/example-disabled.ts"), `${apiStubExports}\n`);
	writeFileSync(join(aiDir, "src/providers/example.models.ts"), "export const EXAMPLE_MODELS = {};\n");
	if (withProviderStub) {
		writeFileSync(
			join(aiDir, "src/providers/disabled/example-models.ts"),
			"export const EXAMPLE_MODELS: Record<string, never> = {};\nexport const value = { EXAMPLE_MODELS };\n",
		);
	}
	return aiDir;
}

/**
 * Runs the plugin's resolve hook the way esbuild would for one import. A plugin
 * with nothing to stub registers no hook at all, which resolves to undefined.
 */
function resolveWith(plugin, args) {
	let handler;
	plugin.setup({ onResolve: (_options, callback) => (handler = callback) });
	return handler === undefined ? undefined : handler(args);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readApiModuleIds / readProviderModuleIds", () => {
	it("lists the generated modules and ignores everything else", () => {
		const aiDir = fixture();
		strictEqual(readApiModuleIds(aiDir).join(","), "example");
		strictEqual(readProviderModuleIds(aiDir).join(","), "example");
	});
});

describe("validateStubs", () => {
	it("accepts a stub that exports every name of its module", () => {
		validateStubs(fixture());
	});

	it("rejects a stub that dropped an export", () => {
		throws(() => validateStubs(fixture({ apiStubExports: "export const other = () => {};" })), /example: stub is missing exampleApi/);
	});

	it("rejects an API without a stub", () => {
		const aiDir = fixture();
		rmSync(join(aiDir, "src/api/disabled/example-disabled.ts"));
		throws(() => validateStubs(aiDir), /example: no src\/api\/disabled\/example-disabled.ts/);
	});

	it("rejects a provider without a stub", () => {
		throws(() => validateStubs(fixture({ withProviderStub: false })), /example: no src\/providers\/disabled\/example-models.ts/);
	});
});

describe("createApiStubPlugin", () => {
	it("leaves every module alone when the sets are full", () => {
		const { plugin, disabledApis, disabledProviders } = createApiStubPlugin({
			aiDir: fixture(),
			apis: ["__ALL__"],
			builtinProviderIds: undefined,
		});
		strictEqual(disabledApis.length, 0);
		strictEqual(disabledProviders.length, 0);
		strictEqual(resolveWith(plugin, { path: "./example.lazy.js", resolveDir: "/repo/dist/api" }), undefined);
	});

	it("aliases a dropped API wrapper to its stand-in", () => {
		const aiDir = fixture();
		const { plugin, disabledApis } = createApiStubPlugin({ aiDir, apis: ["openai-completions"], builtinProviderIds: undefined });
		strictEqual(disabledApis.join(","), "example");
		const result = resolveWith(plugin, { path: "./example.lazy.js", resolveDir: join(aiDir, "dist/api") });
		strictEqual(result?.path, join(aiDir, "dist/api/disabled/example-disabled.js"));
	});

	it("aliases a dropped catalog shard to its stand-in", () => {
		const aiDir = fixture();
		const { plugin, disabledProviders } = createApiStubPlugin({
			aiDir,
			apis: ["__ALL__"],
			builtinProviderIds: ["some-other-provider"],
		});
		strictEqual(disabledProviders.join(","), "example");
		const result = resolveWith(plugin, { path: "./example.models.js", resolveDir: join(aiDir, "dist/providers") });
		strictEqual(result?.path, join(aiDir, "dist/providers/disabled/example-models.js"));
	});

	it("ignores package imports of modules it does not stub", () => {
		const { plugin } = createApiStubPlugin({
			aiDir: fixture(),
			apis: ["__ALL__"],
			builtinProviderIds: ["example"],
		});
		strictEqual(resolveWith(plugin, { path: "openai" }), undefined);
	});
});
