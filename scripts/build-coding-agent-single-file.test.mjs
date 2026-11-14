import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

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

// #742: the nightly job checked the tarball with
// `tar -tzf "$tarball" | grep -q '\.node$'` under `set -o pipefail`. `grep -q`
// exits as soon as it matches, `tar` still has the rest of the listing to write
// and dies of SIGPIPE, and pipefail turns that into a failed pipeline — so a
// tarball that does contain a `.node` fails the check. The listing is small
// enough to sit inside the pipe buffer most of the time, which is why it read
// as a flake. The step now reads the listing into a variable first.
//
// The step is executed, not pattern-matched: the defect lives in how the two
// processes interleave, and a source assertion cannot see that.
function collectStepScript() {
	const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/nightly.yml", import.meta.url)), "utf8");
	const step = parse(workflow)
		.jobs.build.steps.find((candidate) => candidate.name === "Collect TUI native prebuilds");
	assert.ok(step?.run, "the Collect TUI native prebuilds step is missing");
	return step.run;
}

function sidecarFixture(t, { withNode, entries }) {
	const root = mkdtempSync(join(tmpdir(), "nanopi-nightly-sidecar-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const binaries = join(root, "packages", "coding-agent", "binaries");
	const staging = join(root, "staging");
	const native = join(staging, "native");
	mkdirSync(binaries, { recursive: true });
	mkdirSync(native, { recursive: true });
	// The `.node` entry comes first on purpose: `tar` matches it, `grep -q`
	// exits, and everything tar still wanted to write dies of EPIPE. The listing
	// also has to outgrow the 64 KiB pipe buffer, otherwise tar finishes writing
	// before grep exits and the old form passes by luck.
	const listed = [];
	if (withNode) {
		writeFileSync(join(native, "0000-tui.node"), "");
		listed.push("native/0000-tui.node");
	}
	for (let index = 0; index < entries; index += 1) {
		const name = `prebuild-entry-with-a-long-descriptive-name-${index}.txt`;
		writeFileSync(join(native, name), "");
		listed.push(`native/${name}`);
	}
	execFileSync("tar", ["-czf", join(binaries, "nanopi-sidecars-20261031.1.0.tgz"), "-C", staging, ...listed]);
	mkdirSync(join(root, "release-assets"));
	return root;
}

test("the nightly sidecar check accepts a tarball that carries a .node file", (t) => {
	const root = sidecarFixture(t, { withNode: true, entries: 2000 });
	const result = spawnSync("bash", ["-e", "-c", collectStepScript()], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.ok(existsSync(join(root, "release-assets")), "the tarball is moved into release-assets/");
});

test("the nightly sidecar check rejects a tarball without one", (t) => {
	const root = sidecarFixture(t, { withNode: false, entries: 2000 });
	const result = spawnSync("bash", ["-e", "-c", collectStepScript()], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.status, 1);
	assert.match(result.stdout + result.stderr, /sidecar tarball carries no prebuilt \.node file/);
});
