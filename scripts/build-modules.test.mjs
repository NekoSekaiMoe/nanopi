import { strictEqual } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createModuleStubPlugin, specifierFor } from "./build-modules.mjs";

const srcDir = "/repo/packages/coding-agent/src";
let tempDirs = [];

function stubDir() {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-module-stubs-test-"));
	tempDirs.push(dir);
	return dir;
}

/** Runs the plugin's onResolve hook against one import path. */
function resolveWith(plugin, path) {
	let handler;
	plugin.setup({ onResolve: (_options, callback) => (handler = callback) });
	return handler({ path });
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("specifierFor", () => {
	it("maps a source path to the compiled import relative to the importer", () => {
		const source = join(srcDir, "extras", "ask-lite", "index.ts");
		strictEqual(specifierFor(srcDir, source, 1), "../extras/ask-lite/index.js");
		strictEqual(specifierFor(srcDir, source, 2), "../../extras/ask-lite/index.js");
	});

	it("maps a workspace package source to its own relative path", () => {
		strictEqual(specifierFor(srcDir, "/repo/packages/extra/src/index.ts", 2), "../../../../extra/src/index.js");
	});
});

describe("createModuleStubPlugin", () => {
	const modules = [
		{ name: "ask-lite", specifiers: ["../extras/ask-lite/index.js"] },
		{ name: "llama.cpp", specifiers: ["../modules/llama/index.js"] },
	];

	it("leaves every module alone when the flavor keeps them all", () => {
		const { disabled } = createModuleStubPlugin({
			stubDir: stubDir(),
			modules,
			components: { "module/ask-lite": true, "module/llama.cpp": true },
		});
		strictEqual(disabled.length, 0);
	});

	it("redirects a disabled module import to an inert stub", () => {
		const dir = stubDir();
		const { plugin, disabled } = createModuleStubPlugin({
			stubDir: dir,
			modules,
			components: { "module/ask-lite": false, "module/llama.cpp": true },
		});
		strictEqual(disabled.join(","), "ask-lite");
		const resolved = resolveWith(plugin, "../extras/ask-lite/index.js");
		strictEqual(resolved.path, join(dir, "module-0.mjs"));
		strictEqual(readFileSync(resolved.path, "utf8").includes("export default function noopModule"), true);
		// An enabled module keeps its real import.
		strictEqual(resolveWith(plugin, "../modules/llama/index.js"), undefined);
	});
});
