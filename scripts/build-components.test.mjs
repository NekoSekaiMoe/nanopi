import { strictEqual, throws } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createComponentStubPlugin,
	createLazyImportDropPlugin,
	resolveComponentSwitches,
	validateComponentStubExports,
} from "./build-components.mjs";

let tempDirs = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-component-stubs-test-"));
	tempDirs.push(dir);
	return dir;
}

const JITI_LOADER_EXPORTS = "export function loadDiskModules(): Promise<void> {\n\treturn Promise.resolve();\n}\n";

/** A coding-agent source + dist pair with each component module and its stand-in. */
function fixture({ stubSource = 'export function highlight(code: string): string { return code; }\n' } = {}) {
	const dir = tempDir();
	mkdirSync(join(dir, "src/utils"), { recursive: true });
	mkdirSync(join(dir, "dist/utils"), { recursive: true });
	mkdirSync(join(dir, "dist/modes/interactive/theme"), { recursive: true });
	writeFileSync(join(dir, "src/utils/syntax-highlight.ts"), "export function highlight(code: string): string { return code; }\n");
	writeFileSync(join(dir, "src/utils/syntax-highlight-disabled.ts"), stubSource);
	writeFileSync(join(dir, "dist/utils/syntax-highlight.ts"), "export function highlight(code) { return code; }\n");
	writeFileSync(join(dir, "dist/utils/syntax-highlight.js"), "export function highlight(code) { return code; }\n");
	writeFileSync(join(dir, "dist/utils/syntax-highlight-disabled.ts"), stubSource);
	writeFileSync(join(dir, "dist/utils/syntax-highlight-disabled.js"), "export function highlight(code) { return code; }\n");
	writeFileSync(join(dir, "dist/modes/interactive/theme/theme.js"), "");
	// Every component module needs a module + stub pair in the fixture.
	mkdirSync(join(dir, "src/core/modules"), { recursive: true });
	writeFileSync(join(dir, "src/core/modules/jiti-loader.ts"), JITI_LOADER_EXPORTS);
	writeFileSync(join(dir, "src/core/modules/jiti-loader-disabled.ts"), JITI_LOADER_EXPORTS);
	mkdirSync(join(dir, "src/core/export-markdown"), { recursive: true });
	const markdownExports = "export function run(): string {\n\treturn '';\n}\n";
	writeFileSync(join(dir, "src/core/export-markdown/index.ts"), markdownExports);
	writeFileSync(join(dir, "src/core/export-markdown/index-disabled.ts"), markdownExports);
	return dir;
}

function resolveWith(plugin, args) {
	let handler;
	plugin.setup({ onResolve: (_options, callback) => (handler = callback) });
	return handler === undefined ? undefined : handler(args);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("validateComponentStubExports", () => {
	it("accepts a stub that exports every name of its module", () => {
		validateComponentStubExports(fixture());
	});

	it("rejects a stub that dropped an export", () => {
		throws(() => validateComponentStubExports(fixture({ stubSource: "export const other = 1;\n" })), /missing exports/);
	});
});

describe("createComponentStubPlugin", () => {
	it("does nothing when the component is enabled", () => {
		const { plugin, disabledModules } = createComponentStubPlugin({
			components: { "syntax-highlight": true },
			codingAgentDir: fixture(),
		});
		strictEqual(disabledModules.length, 0);
		strictEqual(resolveWith(plugin, { path: "./x.js", resolveDir: "/" }), undefined);
	});

	it("rewrites every spelling of the disabled module", () => {
		const dir = fixture();
		const { plugin, disabledModules } = createComponentStubPlugin({
			components: { "syntax-highlight": false },
			codingAgentDir: dir,
		});
		strictEqual(disabledModules.length, 1);
		const stubPath = join(dir, "dist/utils/syntax-highlight-disabled.js");
		// Same file, two importers: `./syntax-highlight.js` from dist/utils and a
		// relative climb from dist/modes/interactive/theme.
		strictEqual(
			resolveWith(plugin, { path: "./syntax-highlight.js", resolveDir: join(dir, "dist/utils") })?.path,
			stubPath,
		);
		strictEqual(
			resolveWith(plugin, {
				path: "../../../utils/syntax-highlight.js",
				resolveDir: join(dir, "dist/modes/interactive/theme"),
			})?.path,
			stubPath,
		);
	});

	it("leaves package imports alone", () => {
		const { plugin } = createComponentStubPlugin({
			components: { "syntax-highlight": false },
			codingAgentDir: fixture(),
		});
		strictEqual(resolveWith(plugin, { path: "highlight.js/lib/core.js", resolveDir: "/repo" }), undefined);
	});
});

describe("resolveComponentSwitches", () => {
	it("keeps the flavor's switches for a bundle build", () => {
		const components = resolveComponentSwitches({ components: { "jiti-modules": true, webui: false } });
		strictEqual(components["jiti-modules"], true);
	});

	it("drops jiti from the single file whatever the flavor says", () => {
		const components = resolveComponentSwitches({ components: { "jiti-modules": true }, singleFile: true });
		strictEqual(components["jiti-modules"], false);
	});
});

describe("createLazyImportDropPlugin", () => {
	function resolvePath(plugin, path) {
		let handler;
		plugin.setup({ onResolve: (_options, callback) => (handler = callback), onLoad: () => {} });
		return handler === undefined ? undefined : handler({ path });
	}

	it("leaves the import in place when the component is enabled", () => {
		const plugin = createLazyImportDropPlugin({ components: { "jiti-modules": true } });
		strictEqual(resolvePath(plugin, "jiti"), undefined);
	});

	it("resolves the disabled package somewhere that exports nothing", () => {
		const plugin = createLazyImportDropPlugin({ components: { "jiti-modules": false } });
		strictEqual(resolvePath(plugin, "jiti")?.namespace, "disabled-lazy");
		// Not the lazily imported package: the resolver answers undefined and
		// esbuild keeps looking.
		strictEqual(resolvePath(plugin, "some-other-package"), undefined);
	});
});
