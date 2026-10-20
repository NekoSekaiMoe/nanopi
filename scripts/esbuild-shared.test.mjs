import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { describe, it } from "node:test";
import { buildDefines, BUNDLE_EXTERNAL_PACKAGES, SINGLE_FILE_EXTERNAL_PACKAGES, validateExternalImports } from "./esbuild-shared.mjs";

const selection = {
	flavor: "minimal",
	components: { webui: false, toolset: "bash" },
	toolset: "bash",
	toolNames: ["bash"],
	builtinProviderIds: [],
	builtinApiIds: ["openai-completions"],
	buildCommit: "abc123",
};

describe("buildDefines", () => {
	it("injects every define the runtime reads back", () => {
		deepStrictEqual(Object.keys(buildDefines(selection)).sort(), [
			"NANOPI_BUILD_APIS",
			"NANOPI_BUILD_COMMIT",
			"NANOPI_BUILD_COMPONENTS",
			"NANOPI_BUILD_FLAVOR",
			"NANOPI_BUILD_PROVIDERS",
			"NANOPI_BUILD_TOOLS",
			"NANOPI_BUILD_TOOLSET",
			"NANOPI_BUNDLED_NODE",
		]);
	});

	it("never emits an undefined value esbuild would reject", () => {
		// A full provider set is `undefined` (every catalog ships) and a tool set
		// that names no tools is too; esbuild rejects an undefined define value.
		const defines = buildDefines({ ...selection, builtinProviderIds: undefined, toolNames: undefined });
		deepStrictEqual(JSON.parse(defines.NANOPI_BUILD_TOOLS), []);
		strictEqual(typeof defines.NANOPI_BUILD_PROVIDERS, "string");
	});
});

describe("validateExternalImports", () => {
	const metafile = (imports) => ({
		inputs: { "src/index.js": { imports } },
	});

	it("accepts builtins, allowed packages, and define placeholders", () => {
		validateExternalImports(
			[metafile([{ path: "node:fs", external: true }, { path: "bufferutil", external: true }, { path: "<define:NANOPI_BUILD_APIS>", external: true }])],
			new Set(BUNDLE_EXTERNAL_PACKAGES),
		);
	});

	it("rejects an unexpected external import", () => {
		throws(
			() => validateExternalImports([metafile([{ path: "left-pad", external: true }])], new Set(SINGLE_FILE_EXTERNAL_PACKAGES)),
			/left-pad/,
		);
	});
});
