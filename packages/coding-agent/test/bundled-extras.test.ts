import { deepStrictEqual, strictEqual } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { BUNDLED_EXTRA_MARKER, installBundledExtras, listBundledExtras } from "../src/core/bundled-extras.ts";

function writeDistExtras(names: string[]): { repoRoot: string; distDir: string; installRoot: string } {
	const repoRoot = mkdtempSync(join(tmpdir(), "nanopi-bundled-extras-"));
	const distDir = join(repoRoot, "dist", "extras");
	for (const name of names) {
		mkdirSync(join(distDir, name), { recursive: true });
		writeFileSync(join(distDir, name, "package.json"), `{"name":"${name}"}\n`);
		writeFileSync(join(distDir, name, "index.ts"), `export const name = "${name}";\n`);
	}
	const installRoot = join(repoRoot, "packages-root");
	return { repoRoot, distDir, installRoot };
}

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("listBundledExtras", () => {
	it("lists extra directories and tolerates a missing root", () => {
		const { distDir } = writeDistExtras(["ask-lite", "pi-ui"]);
		tempDirs.push(distDir);
		deepStrictEqual(listBundledExtras(distDir), ["ask-lite", "pi-ui"]);
		deepStrictEqual(listBundledExtras(join(distDir, "missing")), []);
	});
});

describe("installBundledExtras", () => {
	it("installs missing extras with a version marker", () => {
		const { repoRoot, distDir, installRoot } = writeDistExtras(["ask-lite"]);
		tempDirs.push(repoRoot);
		const installed = installBundledExtras(distDir, installRoot, "1.2.3");
		deepStrictEqual(installed, [join(installRoot, "ask-lite")]);
		strictEqual(readFileSync(join(installRoot, "ask-lite", BUNDLED_EXTRA_MARKER), "utf8").trim(), "1.2.3");
		strictEqual(existsSync(join(installRoot, "ask-lite", "index.ts")), true);
	});

	it("skips the copy when the marker version matches", () => {
		const { repoRoot, distDir, installRoot } = writeDistExtras(["ask-lite"]);
		tempDirs.push(repoRoot);
		installBundledExtras(distDir, installRoot, "1.2.3");
		// User edits their installed copy; a same-version run must not clobber it.
		writeFileSync(join(installRoot, "ask-lite", "user-edit.txt"), "keep me");
		installBundledExtras(distDir, installRoot, "1.2.3");
		strictEqual(existsSync(join(installRoot, "ask-lite", "user-edit.txt")), true);
	});

	it("replaces marker-carrying extras on version change", () => {
		const { repoRoot, distDir, installRoot } = writeDistExtras(["ask-lite"]);
		tempDirs.push(repoRoot);
		installBundledExtras(distDir, installRoot, "1.2.3");
		writeFileSync(join(installRoot, "ask-lite", "user-edit.txt"), "replace me");
		installBundledExtras(distDir, installRoot, "1.3.0");
		strictEqual(existsSync(join(installRoot, "ask-lite", "user-edit.txt")), false);
		strictEqual(readFileSync(join(installRoot, "ask-lite", BUNDLED_EXTRA_MARKER), "utf8").trim(), "1.3.0");
	});

	it("never touches user-owned directories without a marker", () => {
		const { repoRoot, distDir, installRoot } = writeDistExtras(["ask-lite"]);
		tempDirs.push(repoRoot);
		mkdirSync(join(installRoot, "ask-lite"), { recursive: true });
		writeFileSync(join(installRoot, "ask-lite", "package.json"), '{"name":"user-copy"}');
		const installed = installBundledExtras(distDir, installRoot, "1.2.3");
		deepStrictEqual(installed, [join(installRoot, "ask-lite")]);
		strictEqual(existsSync(join(installRoot, "ask-lite", BUNDLED_EXTRA_MARKER)), false);
		strictEqual(readFileSync(join(installRoot, "ask-lite", "package.json"), "utf8"), '{"name":"user-copy"}');
	});
});
