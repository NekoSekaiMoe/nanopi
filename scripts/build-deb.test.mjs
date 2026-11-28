import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDebianPackage, formatRfc2822Utc, prependChangelogEntry, resolveDebVersion } from "./build-deb.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const buildDebScript = fileURLToPath(new URL("./build-deb.mjs", import.meta.url));

function hasDebianTools() {
	return (
		spawnSync("which", ["dpkg-buildpackage"], { stdio: "ignore" }).status === 0 &&
		spawnSync("which", ["dh"], { stdio: "ignore" }).status === 0
	);
}

test("resolveDebVersion normalizes release tags and validates native versions", () => {
	assert.equal(resolveDebVersion({ tag: "v20261128" }), "20261128.0.0");
	assert.equal(resolveDebVersion({ tag: "20261128.1" }), "20261128.1.0");
	assert.equal(resolveDebVersion({ tag: "v20261128.1.0" }), "20261128.1.0");
	assert.equal(resolveDebVersion({ version: "20261128.0.0+nightly.20261129" }), "20261128.0.0+nightly.20261129");
	assert.equal(resolveDebVersion({ fallbackVersion: "20261128.0.0" }), "20261128.0.0");

	assert.throws(() => resolveDebVersion({ version: "20261128.0.0", tag: "v20261128" }), /cannot be combined/);
	assert.throws(() => resolveDebVersion({ version: "v20261128.0.0" }), /Invalid native Debian version/);
	assert.throws(() => resolveDebVersion({ version: "20261128.0.0-nightly.20261129" }), /Invalid native Debian version/);
	assert.throws(() => resolveDebVersion({ tag: "nightly" }), /Invalid release tag/);
});

test("formatRfc2822Utc and prependChangelogEntry produce Debian-valid changelog entries", () => {
	const stamp = formatRfc2822Utc(new Date("2026-11-28T20:42:09Z"));
	assert.equal(stamp, "Sat, 28 Nov 2026 20:42:09 +0000");

	const updated = prependChangelogEntry({
		existing: "nanopi (20261128.0.0) unstable; urgency=medium\n\n  * Initial.\n\n -- SekaiMoe <sekaimoe@proton.me>  Sat, 28 Nov 2026 20:42:09 +0800\n",
		version: "20261128.0.0+nightly.20261129",
		date: new Date("2026-11-29T00:05:00Z"),
	});
	assert.match(updated, /^nanopi \(20261128\.0\.0\+nightly\.20261129\) unstable; urgency=medium\n/);
	assert.match(updated, /Sun, 29 Nov 2026 00:05:00 \+0000/);
	assert.match(updated, /nanopi \(20261128\.0\.0\) unstable; urgency=medium/);
});

test("build-deb CLI --help exits zero and missing bundle fails fast", () => {
	const help = spawnSync(process.execPath, [buildDebScript, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--bundle <path>/);

	const missing = spawnSync(process.execPath, [buildDebScript, "--bundle", "/does/not/exist/nanopi.js", "--version", "20261128.0.0"], {
		encoding: "utf8",
	});
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /Bundle does not exist/);
});

test("buildDebianPackage builds an Architecture: all .deb that installs and runs /usr/bin/nanopi", { skip: !hasDebianTools() }, (t) => {
	const work = mkdtempSync(join(tmpdir(), "nanopi-deb-test-"));
	t.after(() => rmSync(work, { recursive: true, force: true }));

	const bundle = join(work, "nanopi.js");
	writeFileSync(
		bundle,
		'#!/usr/bin/env node\nimport { basename } from "node:path";\nconsole.log(`stub:${basename(process.argv[1])}:${process.argv.slice(2).join(",")}`);\n',
		{ mode: 0o755 },
	);
	const outDir = join(work, "out");
	mkdirSync(outDir);

	const version = "20261128.0.0+nightly.20261129";
	const debPath = buildDebianPackage({
		repoRoot,
		bundlePath: bundle,
		version,
		outDir,
		buildDate: new Date("2026-11-29T00:00:00Z"),
	});

	assert.equal(debPath, join(outDir, `nanopi_${version}_all.deb`));
	assert.equal(existsSync(debPath), true);

	const info = spawnSync("dpkg-deb", ["--info", debPath], { encoding: "utf8" });
	assert.equal(info.status, 0, info.stderr);
	assert.match(info.stdout, /Package: nanopi/);
	assert.match(info.stdout, new RegExp(`Version: ${version.replace(/[.+]/g, "\\$&")}`));
	assert.match(info.stdout, /Architecture: all/);
	assert.match(info.stdout, /Depends: nodejs \(>= 24\)/);

	const contents = spawnSync("dpkg-deb", ["--contents", debPath], { encoding: "utf8" });
	assert.equal(contents.status, 0, contents.stderr);
	assert.match(contents.stdout, /\/usr\/share\/nanopi\/nanopi\.js/);
	assert.match(contents.stdout, /\/usr\/bin\/nanopi -> \.\.\/share\/nanopi\/nanopi\.js/);
	assert.match(contents.stdout, /\/usr\/share\/doc\/nanopi\/README\.md/);

	const extracted = join(work, "extracted");
	mkdirSync(extracted);
	const extract = spawnSync("dpkg-deb", ["-x", debPath, extracted], { encoding: "utf8" });
	assert.equal(extract.status, 0, extract.stderr);

	const runBin = spawnSync(join(extracted, "usr", "bin", "nanopi"), ["--version"], { encoding: "utf8" });
	assert.equal(runBin.status, 0, runBin.error?.message ?? runBin.stderr);
	assert.equal(runBin.stdout.trim(), "stub:nanopi:--version");
});
