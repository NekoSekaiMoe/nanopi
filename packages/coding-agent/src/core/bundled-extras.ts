/**
 * Bundled extras: peripheral packages vendored under
 * packages/coding-agent/extras and shipped in dist/extras by build flavors
 * (one `extra/<name>` component per package, see buildconfig.json and
 * scripts/extras.mjs).
 *
 * Registration mirrors user packages rather than inlining them: the extras
 * present in dist/extras are appended to the package manager's sources with
 * the lowest precedence, so project and user settings keep winning. Which
 * directory each extra resolves from depends on the distribution:
 *
 * - npm installs and source checkouts register dist/extras/<name> in place.
 * - single-file builds extract their asset payload (including dist/extras)
 *   into the versioned cache directory and then copy each extra to
 *   ~/.nanopi/packages/<name>, a stable, user-visible location. A directory
 *   there without our marker is user-owned and never touched; ours carries a
 *   version + content marker and is replaced when either changes.
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getPackageDir, VERSION } from "../config.ts";
import { isSingleNodeFileRuntime } from "../standalone/assets.ts";

/** Marker file proving an extras directory is ours and recording its version. */
export const BUNDLED_EXTRA_MARKER = ".nanopi-extra-version";

/** Env override disabling bundled extras registration (tests use this; users can too). */
export const BUNDLED_EXTRAS_ENV = "NANOPI_BUNDLED_EXTRAS";

function isBundledExtrasEnabled(): boolean {
	const value = process.env[BUNDLED_EXTRAS_ENV];
	return value !== "0" && value !== "false";
}

/** dist/extras inside the package dir (npm dist or the extracted single-file cache). */
export function getBundledExtrasDistDir(): string {
	return join(getPackageDir(), "dist", "extras");
}

/** Durable install root for single-file runs: ~/.nanopi/packages. */
export function getBundledExtrasInstallRoot(): string {
	return join(homedir(), CONFIG_DIR_NAME, "packages");
}

/** Extra names shipped by this build (the flavor's dist/extras contents). */
export function listBundledExtras(distDir = getBundledExtrasDistDir()): string[] {
	if (!existsSync(distDir)) return [];
	return readdirSync(distDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
}

function readMarker(dir: string): string | undefined {
	try {
		const markerPath = join(dir, BUNDLED_EXTRA_MARKER);
		if (!existsSync(markerPath)) return undefined;
		return readFileSync(markerPath, "utf8").trim();
	} catch {
		return undefined;
	}
}

/**
 * Content hash of an extra's tree (sorted relative paths plus file bytes,
 * marker excluded). The install marker pairs the version with this hash, so
 * a same-version rebuild whose files changed still refreshes the install;
 * unchanged content keeps skipping the copy and user edits to marker-carrying
 * installs survive.
 */
function hashExtraTree(dir: string): string {
	const hash = createHash("sha256");
	const visit = (relative: string): void => {
		const entries = readdirSync(join(dir, relative), { withFileTypes: true }).sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
		for (const entry of entries) {
			if (entry.name === BUNDLED_EXTRA_MARKER) continue;
			const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				hash.update(`d ${relativePath}\n`);
				visit(relativePath);
			} else if (entry.isFile()) {
				hash.update(`f ${relativePath}\n`);
				hash.update(readFileSync(join(dir, relativePath)));
			}
		}
	};
	visit("");
	return hash.digest("hex");
}

/**
 * Copies each extra from sourceDir into installRoot/<name>. Directories that
 * are absent, user-owned (no marker), or already current (marker matches the
 * bundled version and content hash) are left alone; version or content
 * changes replace the directory atomically (staging copy + rename).
 *
 * @returns the install paths for all extras, including untouched user-owned ones.
 */
export function installBundledExtras(sourceDir: string, installRoot: string, version: string): string[] {
	const installed: string[] = [];
	for (const name of listBundledExtras(sourceDir)) {
		const source = join(sourceDir, name);
		const target = join(installRoot, name);
		const marker = readMarker(target);
		if (marker === undefined && existsSync(target)) {
			// User-owned directory: never overwrite, register as-is.
			installed.push(target);
			continue;
		}
		const expectedMarker = `${version}\n${hashExtraTree(source)}`;
		if (marker === expectedMarker && existsSync(join(target, BUNDLED_EXTRA_MARKER))) {
			installed.push(target);
			continue;
		}
		const staging = `${target}.tmp-${process.pid}`;
		rmSync(staging, { recursive: true, force: true });
		try {
			mkdirSync(installRoot, { recursive: true });
			cpSync(source, staging, { recursive: true });
			writeFileSync(join(staging, BUNDLED_EXTRA_MARKER), `${expectedMarker}\n`);
			rmSync(target, { recursive: true, force: true });
			try {
				renameSync(staging, target);
			} catch {
				// Another process won the race; its tree is current, drop ours.
				rmSync(staging, { recursive: true, force: true });
			}
		} catch (error) {
			rmSync(staging, { recursive: true, force: true });
			throw error;
		}
		installed.push(target);
	}
	return installed;
}

function readPackageName(dir: string): string | undefined {
	try {
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: string };
		return typeof manifest.name === "string" ? manifest.name : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Package sources (local paths) for the extras this build ships, lowest
 * precedence. Extras the user already configured as `npm:<name>` packages are
 * skipped so the same package is not loaded twice; path-level collisions are
 * deduplicated by the package manager itself.
 */
export function getBundledExtraPackageSources(configuredPackages: Array<string | { source: string }>): string[] {
	if (!isBundledExtrasEnabled()) return [];
	const distDir = getBundledExtrasDistDir();
	const names = listBundledExtras(distDir);
	if (names.length === 0) return [];

	const configuredNpmNames = new Set(
		configuredPackages
			.map((pkg) => (typeof pkg === "string" ? pkg : pkg.source))
			.filter((source): source is `npm:${string}` => source.startsWith("npm:"))
			.map((source) => {
				const spec = source.slice("npm:".length).trim();
				const versionSeparator = spec.lastIndexOf("@");
				return versionSeparator > 0 ? spec.slice(0, versionSeparator) : spec;
			}),
	);

	const dirs = isSingleNodeFileRuntime()
		? installBundledExtras(distDir, getBundledExtrasInstallRoot(), VERSION)
		: names.map((name) => join(distDir, name));

	return dirs.filter((dir) => {
		const packageName = readPackageName(dir);
		return packageName === undefined || !configuredNpmNames.has(packageName);
	});
}
