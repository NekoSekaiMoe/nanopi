import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The sidecar manifest bakes these URLs into every published bundle, so the
// list is a contract: GitHub first, then the two AtomGit tags the publishing
// flows write. A host that moves breaks installs in the field, not in CI.
const script = fileURLToPath(new URL("./build-coding-agent-single-file.mjs", import.meta.url));

test("the TUI sidecar is reachable from GitHub and from both AtomGit tags", () => {
	const source = readFileSync(script, "utf8");
	// The URL builders are read from the source instead of imported: the module
	// bundles the whole CLI at import time and needs a full workspace build.
	const atomgit = source.match(/export function atomgitSidecarTarballUrls\(version, name, slug = ATOMGIT_ASSETS_SLUG\) \{([\s\S]*?)\n\}/);
	assert.ok(atomgit, "atomgitSidecarTarballUrls is missing");
	assert.match(source, /const ATOMGIT_ASSETS_SLUG = "nanopi\/releases-assets";/);
	assert.match(atomgit[1], /raw\/main\/v\$\{version\}\/\$\{name\}/);
	assert.match(atomgit[1], /raw\/main\/nightly\/\$\{name\}/);
	assert.match(source, /https:\/\/github\.com\/\$\{repository\}\/releases\/download\/v\$\{version\}\/\$\{name\}/);
});

// #625: the tarball used to be written next to --out. The nightly job puts
// each bundle in release-assets/ and then looks for exactly one tarball in
// packages/coding-agent/binaries/ — next to --out meant one per flavor inside
// release-assets/ and zero where the job looked, so the nightly build failed
// before it could publish anything.
test("the sidecar tarball lands in the agent bin directory, not next to --out", () => {
	const source = readFileSync(script, "utf8");
	assert.match(source, /const sidecarArchivePath = join\(dirname\(defaultOutput\), `nanopi-sidecars-\$\{tuiSource\.version\}\.tgz`\);/);
	assert.doesNotMatch(source, /const sidecarArchivePath = join\(dirname\(outputFilePath\)/);
});
