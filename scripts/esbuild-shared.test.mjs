import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import { describe, it } from "node:test";
import { buildDefines, BUNDLE_EXTERNAL_PACKAGES, selfReferencePlugin, SINGLE_FILE_EXTERNAL_PACKAGES, validateExternalImports } from "./esbuild-shared.mjs";

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

const tempDirs = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("selfReferencePlugin", () => {
	const plugin = selfReferencePlugin({ packageName: "@demo/self", packageDir: "/repo/packages/demo" });

	/** Runs the plugin's onResolve hook against one import path. */
	function resolvePath(path) {
		let handler;
		plugin.setup({ onResolve: (_options, callback) => (handler = callback) });
		return handler({ path });
	}

	it("claims the package name alone and leaves subpaths to esbuild", () => {
		// Only the bare name is a self-reference; `@demo/self/rpc-entry` must keep
		// esbuild's default resolution, which reads the package's exports map.
		throws(() => resolvePath("@demo/self"));
		strictEqual(resolvePath("@demo/self/rpc-entry"), undefined);
		strictEqual(resolvePath("@demo/other"), undefined);
	});

	it("resolves the name to the compiled entry point", () => {
		// A temp package dir keeps this independent of whether the workspace has
		// been built; the plugin reads `dist/index.js` and nothing else.
		const packageDir = mkdtempSync(join(tmpdir(), "nanopi-self-reference-test-"));
		tempDirs.push(packageDir);
		mkdirSync(join(packageDir, "dist"), { recursive: true });
		writeFileSync(join(packageDir, "dist", "index.js"), "export const DynamicBorder = 1;\n");

		const stubbed = selfReferencePlugin({ packageName: "@demo/self", packageDir });
		let handler;
		stubbed.setup({ onResolve: (_options, callback) => (handler = callback) });
		deepStrictEqual(handler({ path: "@demo/self" }), { path: join(packageDir, "dist", "index.js") });
	});

	it("fails loudly when the compiled entry point is missing", () => {
		// The build would otherwise surface a bare "Could not resolve", which is
		// what a stale tree produced before the plugin existed.
		const packageDir = mkdtempSync(join(tmpdir(), "nanopi-self-reference-test-"));
		tempDirs.push(packageDir);
		const stubbed = selfReferencePlugin({ packageName: "@demo/self", packageDir });
		let handler;
		stubbed.setup({ onResolve: (_options, callback) => (handler = callback) });
		throws(() => handler({ path: "@demo/self" }), /Build the workspace packages first/);
	});
});
