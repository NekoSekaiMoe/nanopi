#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { exitStatus, repositoryRoot } from "./lib/node-runner.mjs";

const PACKAGE_NAME = "nanopi";
const DEFAULT_MAINTAINER = "SekaiMoe <sekaimoe@proton.me>";
const NATIVE_DEB_VERSION_RE = /^[0-9][0-9A-Za-z.+~]*$/;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function usage() {
	return `Usage: node scripts/build-deb.mjs [options]

  --bundle <path>   Prebuilt single-file nanopi.js (default: packages/coding-agent/binaries/nanopi.js)
  --version <ver>   Debian package version (default: packages/coding-agent/package.json version)
  --tag <tag>       Release tag (e.g. v20261128 -> 20261128.0.0); mutually exclusive with --version
  --out <dir>       Output directory for nanopi_<version>_all.deb (default: packages/coding-agent/binaries)
  --help            Print this summary
`;
}

/**
 * Resolve and validate a native Debian package version.
 *
 * Date release tags (`v20261128`, `v20261128.1`) are normalized to three-part
 * lockstep versions (`20261128.0.0`, `20261128.1.0`) so `.deb` versions match
 * `package.json`, `nanopi --version`, and AtomGit directory names, while
 * remaining strictly older than `<base>+nightly.<YYYYMMDD>`.
 */
export function resolveDebVersion({ version, tag, fallbackVersion } = {}) {
	if (version && tag) {
		throw new Error("--version and --tag cannot be combined");
	}
	let resolved;
	if (tag) {
		const bare = tag.startsWith("v") ? tag.slice(1) : tag;
		if (!/^\d{8}(?:\.\d+){0,2}$/.test(bare)) {
			throw new Error(`Invalid release tag for Debian version: ${tag}`);
		}
		const parts = bare.split(".");
		resolved = [...parts, "0", "0"].slice(0, 3).join(".");
	} else {
		resolved = version ?? fallbackVersion;
	}
	if (!resolved || !NATIVE_DEB_VERSION_RE.test(resolved)) {
		throw new Error(
			`Invalid native Debian version "${resolved}": must match ${NATIVE_DEB_VERSION_RE} (no '-' revision or leading 'v')`,
		);
	}
	return resolved;
}

/** Format a Date as a Debian-policy RFC 2822 UTC timestamp (`+0000`). */
export function formatRfc2822Utc(date) {
	const pad = (value) => String(value).padStart(2, "0");
	return (
		`${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
		`${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
	);
}

/** Build a fresh top debian/changelog entry for `version` ahead of any existing history. */
export function prependChangelogEntry({ existing = "", version, maintainer = DEFAULT_MAINTAINER, date = new Date() }) {
	const entry = [
		`${PACKAGE_NAME} (${version}) unstable; urgency=medium`,
		"",
		`  * Package ${PACKAGE_NAME} ${version}.`,
		"",
		` -- ${maintainer}  ${formatRfc2822Utc(date)}`,
	].join("\n");
	const trimmed = existing.trim();
	return trimmed ? `${entry}\n\n${trimmed}\n` : `${entry}\n`;
}

function resolveBuildDate(repoRoot) {
	if (process.env.SOURCE_DATE_EPOCH && /^\d+$/.test(process.env.SOURCE_DATE_EPOCH)) {
		return new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000);
	}
	try {
		const epoch = execFileSync("git", ["show", "-s", "--format=%ct", "HEAD"], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (/^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000);
	} catch {
		// Fall back to wall-clock time when building outside a git checkout.
	}
	return new Date();
}

/**
 * Assemble a temporary Debian source tree from `repoRoot/debian` and build
 * `nanopi_<version>_all.deb` with `dpkg-buildpackage -b -us -uc`.
 */
export function buildDebianPackage({
	repoRoot = repositoryRoot,
	bundlePath,
	version,
	outDir,
	buildDate = resolveBuildDate(repoRoot),
}) {
	const resolvedBundle = resolve(bundlePath);
	if (!existsSync(resolvedBundle)) {
		throw new Error(`Bundle does not exist: ${resolvedBundle}`);
	}
	const firstLine = readFileSync(resolvedBundle, "utf8").split("\n", 1)[0];
	if (!firstLine.startsWith("#!")) {
		throw new Error(`Bundle is missing its shebang line: ${resolvedBundle}`);
	}

	const debName = `${PACKAGE_NAME}_${version}_all.deb`;
	const resolvedOutDir = resolve(outDir);
	mkdirSync(resolvedOutDir, { recursive: true });

	const workDir = mkdtempSync(join(tmpdir(), "nanopi-deb-"));
	try {
		const sourceDir = join(workDir, `${PACKAGE_NAME}-${version}`);
		mkdirSync(sourceDir, { recursive: true });
		cpSync(join(repoRoot, "debian"), join(sourceDir, "debian"), { recursive: true });
		for (const doc of ["README.md", "README.zh-CN.md"]) {
			const docPath = join(repoRoot, doc);
			if (existsSync(docPath)) copyFileSync(docPath, join(sourceDir, doc));
		}

		const changelogPath = join(sourceDir, "debian", "changelog");
		const existingChangelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
		writeFileSync(changelogPath, prependChangelogEntry({ existing: existingChangelog, version, date: buildDate }));

		const epochSeconds = String(Math.floor(buildDate.getTime() / 1000));
		// `-d` skips dpkg-checkbuilddeps requiring `build-essential` (a C/C++
		// compiler toolchain is unused for an Architecture: all JS bundle), while
		// `dh` still requires `debhelper` / `debhelper-compat (= 13)` at runtime.
		const result = spawnSync("dpkg-buildpackage", ["-b", "-us", "-uc", "-d"], {
			cwd: sourceDir,
			env: {
				...process.env,
				DEB_BUILD_OPTIONS: "nocheck",
				NANOPI_DEB_BUNDLE: resolvedBundle,
				SOURCE_DATE_EPOCH: epochSeconds,
			},
			stdio: "inherit",
		});
		const status = exitStatus(result);
		if (status !== 0) {
			throw new Error(`dpkg-buildpackage failed with exit ${status}`);
		}

		const builtDeb = join(workDir, debName);
		if (!existsSync(builtDeb)) {
			throw new Error(`Expected Debian package was not produced: ${builtDeb}`);
		}
		const targetDeb = join(resolvedOutDir, debName);
		copyFileSync(builtDeb, targetDeb);
		return targetDeb;
	} finally {
		rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

function main() {
	const { values } = parseArgs({
		options: {
			bundle: { type: "string" },
			version: { type: "string" },
			tag: { type: "string" },
			out: { type: "string" },
			help: { type: "boolean", default: false },
		},
	});

	if (values.help) {
		process.stdout.write(usage());
		return;
	}

	const defaultVersion = JSON.parse(
		readFileSync(join(repositoryRoot, "packages", "coding-agent", "package.json"), "utf8"),
	).version;
	const version = resolveDebVersion({
		version: values.version,
		tag: values.tag,
		fallbackVersion: defaultVersion,
	});
	const bundlePath = resolve(repositoryRoot, values.bundle ?? join("packages", "coding-agent", "binaries", "nanopi.js"));
	const outDir = resolve(repositoryRoot, values.out ?? dirname(bundlePath));

	const debPath = buildDebianPackage({ repoRoot: repositoryRoot, bundlePath, version, outDir });
	process.stdout.write(`${debPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
