import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { findPackageDirectories } from "./package-workspaces.mjs";

function writeManifest(directory, manifest) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest)}\n`);
}

// A checkout that has built the webui carries .next/build/package.json with no
// name or version, which made sync-versions.js throw before it could bump
// anything.
test("skips build output and vendored extras", (t) => {
	const root = mkdtempSync(join(tmpdir(), "nanopi-package-workspaces-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	writeManifest(join(root, "agent"), { name: "@nanopi/pi-agent-core", version: "1.0.0" });
	writeManifest(join(root, "webui"), { name: "@nanopi/webui", version: "1.0.0" });
	writeManifest(join(root, "webui", ".next"), {});
	writeManifest(join(root, "webui", ".next", "build"), {});
	writeManifest(join(root, "agent", "dist", "chunk"), {});
	writeManifest(join(root, "agent", "node_modules", "typebox"), { name: "typebox" });
	writeManifest(join(root, "coding-agent", "src", "extras", "todo-lite"), { name: "@nanopi/todo-lite" });

	const found = findPackageDirectories(root).map((directory) => relative(root, directory).split("\\").join("/"));
	assert.deepEqual(found, ["agent", "webui"]);
});
