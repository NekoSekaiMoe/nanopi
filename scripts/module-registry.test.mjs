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
	{ name: "ask-lite", factory: askLite },
	{ name: "pi-ui", factory: piUi, hidden: true },
];
`);
		strictEqual(readBuiltinModuleNames(root).join(","), "ask-lite,pi-ui");
	});

	it("counts the module a spread helper registers", () => {
		// Regression: the spread was skipped, so `extra` looked like a
		// component for a module the build no longer had and every build
		// failed validateFlavorModules.
		const root = repoWith(`export const BUILTIN_MODULES: SessionModule[] = [
	...extraModule(),
	{ name: "ask-lite", factory: askLite },
];

function extraModule(): SessionModule[] {
	const factory: ModuleFactory | undefined = isBashOnlyBuild() ? undefined : extraInlineExtension.factory;
	return factory ? [{ name: "extra", factory, hidden: true }] : [];
}
`);
		strictEqual(readBuiltinModuleNames(root).join(","), "extra,ask-lite");
	});

	it("reads a bare const paired with a separate export block (issue #523)", () => {
		// Regression: issue #517 moved `export` off the declaration into a paired
		// `export { BUILTIN_MODULES }` block. The parser used to look only for
		// `export const BUILTIN_MODULES`, so every bundle/single-file build died
		// with "no longer exports BUILTIN_MODULES" before reading a single entry.
		const root = repoWith(`const BUILTIN_MODULES: SessionModule[] = [
	{ name: "ask-lite", factory: askLite },
	{ name: "pi-ui", factory: piUi, hidden: true },
];

export function enabledModules(): SessionModule[] {
	return BUILTIN_MODULES.filter(() => true);
}

// Package-internal: the paired block keeps the name importable by path.
export { BUILTIN_MODULES };
`);
		strictEqual(readBuiltinModuleNames(root).join(","), "ask-lite,pi-ui");
	});

	it("fails the build when the array declaration is gone", () => {
		const root = repoWith(`export function enabledModules(): SessionModule[] {
	return [];
}
`);
		let message;
		try {
			readBuiltinModuleNames(root);
		} catch (error) {
			message = error.message;
		}
		strictEqual(message?.includes("no longer declares the BUILTIN_MODULES array"), true, message);
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
