import { strictEqual } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { readBuiltinModuleNames } from "./module-registry.mjs";

let roots = [];

/** A repo root whose modules barrel holds `source`. */
function repoWith(source) {
	const root = mkdtempSync(join(tmpdir(), "nanopi-module-registry-test-"));
	roots.push(root);
	const dir = join(root, "packages", "coding-agent", "src", "modules");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "index.ts"), source);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readBuiltinModuleNames", () => {
	it("reads literal entries in registration order", () => {
		const root = repoWith(`export const BUILTIN_MODULES: SessionModule[] = [
	{ name: "llama.cpp", factory: llamaExtension },
	{ name: "pi-ui", factory: piUi, hidden: true },
];
`);
		strictEqual(readBuiltinModuleNames(root).join(","), "llama.cpp,pi-ui");
	});

	it("counts the module a spread helper registers", () => {
		// Regression: the spread was skipped, so `extra` looked like a
		// component for a module the build no longer had and every build
		// failed validateFlavorModules.
		const root = repoWith(`export const BUILTIN_MODULES: SessionModule[] = [
	...extraModule(),
	{ name: "llama.cpp", factory: llamaExtension },
];

function extraModule(): SessionModule[] {
	const factory: ModuleFactory | undefined = isBashOnlyBuild() ? undefined : extraInlineExtension.factory;
	return factory ? [{ name: "extra", factory, hidden: true }] : [];
}
`);
		strictEqual(readBuiltinModuleNames(root).join(","), "extra,llama.cpp");
	});

	it("fails the build when a spread helper registers no literal name", () => {
		const root = repoWith(`export const BUILTIN_MODULES: SessionModule[] = [
	...extraModule(),
];

function extraModule(): SessionModule[] {
	return condition ? [makeModule()] : [];
}
`);
		let message;
		try {
			readBuiltinModuleNames(root);
		} catch (error) {
			message = error.message;
		}
		strictEqual(message?.includes("cannot read the module name out of extraModule()"), true, message);
	});
});
