import { deepStrictEqual } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	BUNDLED_EXTRAS_ENV,
	getBundledExtraPackageSources,
	getBundledExtrasDistDir,
	listBundledExtras,
} from "../src/core/bundled-extras.ts";

/**
 * Registration integration against the built package (dist/extras). The rest
 * of the suite runs with NANOPI_BUNDLED_EXTRAS=0 (see vitest.config.ts); each
 * test here clears or sets the override explicitly.
 */

function readPackageName(name: string): string {
	return (JSON.parse(readFileSync(join(getBundledExtrasDistDir(), name, "package.json"), "utf8")) as { name: string })
		.name;
}

const builtDistExists = existsSync(getBundledExtrasDistDir());

describe("bundled extras registration", () => {
	afterEach(() => {
		delete process.env[BUNDLED_EXTRAS_ENV];
	});

	it("registers every extra shipped in dist/extras", { skip: !builtDistExists }, () => {
		delete process.env[BUNDLED_EXTRAS_ENV];
		deepStrictEqual(
			getBundledExtraPackageSources([]),
			listBundledExtras().map((name) => join(getBundledExtrasDistDir(), name)),
		);
	});

	it("skips extras the user configured as npm packages", { skip: !builtDistExists }, () => {
		delete process.env[BUNDLED_EXTRAS_ENV];
		const configured = listBundledExtras().map((name) => `npm:${readPackageName(name)}@1.0.0`);
		deepStrictEqual(getBundledExtraPackageSources(configured), []);
	});

	it("registers nothing when disabled via env", () => {
		process.env[BUNDLED_EXTRAS_ENV] = "0";
		deepStrictEqual(getBundledExtraPackageSources([]), []);
	});
});
