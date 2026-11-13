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
	assert.match(source, /const sidecarArchivePath = join\(sidecarsDir, `nanopi-sidecars-\$\{tuiSource\.version\}\.tgz`\);/);
	assert.match(source, /--sidecars-out/);
	assert.doesNotMatch(source, /const sidecarArchivePath = join\(dirname\(outputFilePath\)/);
});

// The release job builds from an extracted source archive, so the script's
// repoRoot is a temporary tree. Without --sidecars-out the tarball went there
// and was deleted with the tree, and "Prepare GitHub release payload" failed on
// its silent test -f.
test("the release workflow points the sidecar tarball at the workspace", () => {
	const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/build-binaries.yml", import.meta.url)), "utf8");
	const flags = workflow.match(/--sidecars-out "\$\{GITHUB_WORKSPACE\}\/packages\/coding-agent\/binaries"/g) ?? [];
	assert.equal(flags.length, 2, "the full build and the flavor loop both have to pass --sidecars-out");
});
