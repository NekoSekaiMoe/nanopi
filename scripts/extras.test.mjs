import { deepStrictEqual, throws } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveBundledExtras } from "./extras.mjs";

function writeExtras(names) {
	const repoRoot = mkdtempSync(join(tmpdir(), "nanopi-extras-"));
	const extrasDir = join(repoRoot, "packages", "coding-agent", "extras");
	for (const name of names) {
		mkdirSync(join(extrasDir, name), { recursive: true });
		writeFileSync(join(extrasDir, name, "package.json"), `{"name":"${name}"}`);
	}
	return repoRoot;
}

let tempDirs = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveBundledExtras", () => {
	it("returns enabled extras and skips disabled ones", () => {
		const repoRoot = writeExtras(["ask-lite", "pi-ui"]);
		tempDirs.push(repoRoot);
		const components = { "extra/ask-lite": true, "extra/pi-ui": false, webui: true };
		deepStrictEqual(
			resolveBundledExtras({ repoRoot, components }).map((extra) => extra.name),
			["ask-lite"],
		);
	});

	it("fails when a vendored directory has no component", () => {
		const repoRoot = writeExtras(["ask-lite", "pi-ui"]);
		tempDirs.push(repoRoot);
		throws(
			() => resolveBundledExtras({ repoRoot, components: { webui: true } }),
			/Vendored extras without an "extra\/<name>" component.*ask-lite, pi-ui/,
		);
	});

	it("fails when a component has no vendored directory", () => {
		const repoRoot = writeExtras(["ask-lite"]);
		tempDirs.push(repoRoot);
		throws(
			() => resolveBundledExtras({ repoRoot, components: { "extra/ask-lite": true, "extra/pi-ui": true } }),
			/no vendored directory: pi-ui/,
		);
	});

	it("returns an empty list when the extras directory is absent", () => {
		const repoRoot = mkdtempSync(join(tmpdir(), "nanopi-extras-empty-"));
		tempDirs.push(repoRoot);
		deepStrictEqual(resolveBundledExtras({ repoRoot, components: { "extra/ask-lite": true } }), []);
	});
});
