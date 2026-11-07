import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * #555: the npm package's `bin` is `dist/bundle/cli.js`, an esbuild bundle, and
 * `buildDefines()` marks every bundle it produces with `NANOPI_BUNDLED_NODE`.
 * `diskModulesIncluded()` read that marker as "this build loads no disk
 * modules", so a nanopi installed from npm ignored all three directories
 * `docs/modules.md` says it loads. The npm bundle ships jiti as a dependency
 * and resolves it at runtime; only the single-file artifact has none, and that
 * one is reported by `NANOPI_SINGLE_FILE`.
 *
 * The markers are esbuild defines, so they are injected here and the module is
 * re-imported, the same way the shell-only prompt test does it.
 */
async function importLoader(defines: Record<string, unknown>) {
	vi.resetModules();
	for (const [name, value] of Object.entries(defines)) vi.stubGlobal(name, value);
	return await import("../src/core/modules/jiti-loader.ts");
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("disk modules in a bundled build", () => {
	test("loads disk modules in the esbuild bundle the npm package ships", async () => {
		const { diskModulesIncluded } = await importLoader({
			NANOPI_BUNDLED_NODE: true,
			NANOPI_BUILD_COMPONENTS: { "jiti-modules": true },
		});
		expect(diskModulesIncluded()).toBe(true);
	});

	test("loads none in a build that dropped the jiti-modules component", async () => {
		const { diskModulesIncluded } = await importLoader({
			NANOPI_BUNDLED_NODE: true,
			NANOPI_BUILD_COMPONENTS: { "jiti-modules": false },
		});
		expect(diskModulesIncluded()).toBe(false);
	});

	test("loads none in the single-file artifact, which keeps jiti external", async () => {
		const { diskModulesIncluded } = await importLoader({
			NANOPI_BUNDLED_NODE: true,
			NANOPI_SINGLE_FILE: true,
			// The real artifact carries these; the bootstrap reads them by name.
			NANOPI_SINGLE_FILE_VERSION: "0.0.0",
			NANOPI_SINGLE_FILE_ASSETS: undefined,
			NANOPI_BUILD_COMPONENTS: { "jiti-modules": true },
		});
		expect(diskModulesIncluded()).toBe(false);
	});

	test("loads disk modules in a source checkout, which sets no marker", async () => {
		const { diskModulesIncluded } = await importLoader({});
		expect(diskModulesIncluded()).toBe(true);
	});
});
