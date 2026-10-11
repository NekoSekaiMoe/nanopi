import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Single-file bundle bootstrap: extract embedded package assets.
 *
 * The single-file nanopi.js inlines the JavaScript graph but the CLI still
 * reads data files by path (themes, HTML export templates, webui, docs,
 * examples, package.json). This module extracts them from a gzip+base64
 * payload injected at build time into a versioned cache directory, then points
 * NANOPI_PACKAGE_DIR at it so every config.ts path helper resolves normally.
 *
 * All inputs are esbuild defines; in any other runtime (source checkouts, npm
 * installs) this module is inert.
 *
 * This module must not import from the package: config.ts resolves the package
 * dir at module init, which happens before this module's body could set the
 * environment. Node builtins only, and the few mirrored constants below.
 */

/** Build-time marker, only true in single-file bundles. */
declare const NANOPI_SINGLE_FILE: boolean | undefined;
declare const NANOPI_SINGLE_FILE_ASSETS: string | undefined;
declare const NANOPI_SINGLE_FILE_VERSION: string | undefined;

/** Marker file proving an extraction completed. */
export const ASSETS_COMPLETE_MARKER = ".complete";

export function isSingleNodeFileRuntime(): boolean {
	return typeof NANOPI_SINGLE_FILE !== "undefined" && NANOPI_SINGLE_FILE;
}

function getCacheRoot(): string {
	if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
	if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
	return join(homedir(), ".cache");
}

/**
 * Extracts a {relativePath: base64Content} gzip payload into targetDir.
 * Stages into a sibling temp directory and renames atomically so a crash
 * never leaves a half-written tree that later looks installed.
 */
export function extractAssetsPayload(payloadBase64: string, targetDir: string): void {
	const archive = JSON.parse(gunzipSync(Buffer.from(payloadBase64, "base64")).toString("utf8")) as Record<
		string,
		string
	>;
	const stagingDir = `${targetDir}.tmp-${process.pid}`;
	rmSync(stagingDir, { recursive: true, force: true });
	mkdirSync(stagingDir, { recursive: true });
	try {
		for (const [relativePath, contentBase64] of Object.entries(archive)) {
			const destination = join(stagingDir, relativePath);
			mkdirSync(dirname(destination), { recursive: true });
			writeFileSync(destination, Buffer.from(contentBase64, "base64"));
		}
		writeFileSync(join(stagingDir, ASSETS_COMPLETE_MARKER), "");
		rmSync(targetDir, { recursive: true, force: true });
		try {
			renameSync(stagingDir, targetDir);
		} catch {
			// Another process won the race; its tree is complete, drop ours.
			rmSync(stagingDir, { recursive: true, force: true });
		}
	} catch (error) {
		rmSync(stagingDir, { recursive: true, force: true });
		throw error;
	}
}

function removeStaleVersionDirs(currentVersion: string): void {
	const versionsRoot = join(getCacheRoot(), "nanopi", "standalone");
	let entries: string[];
	try {
		entries = readdirSync(versionsRoot);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry !== currentVersion) {
			rmSync(join(versionsRoot, entry), { recursive: true, force: true });
		}
	}
}

function bootstrapEmbeddedAssets(): void {
	const version = NANOPI_SINGLE_FILE_VERSION;
	const payload = NANOPI_SINGLE_FILE_ASSETS;
	if (typeof version !== "string" || typeof payload !== "string") return;

	const targetDir = join(getCacheRoot(), "nanopi", "standalone", version);
	try {
		if (!existsSync(join(targetDir, ASSETS_COMPLETE_MARKER))) {
			extractAssetsPayload(payload, targetDir);
		}
		if (existsSync(join(targetDir, ASSETS_COMPLETE_MARKER))) {
			// Respect a user-provided package dir; it wins over the cache.
			process.env.NANOPI_PACKAGE_DIR ??= targetDir;
			removeStaleVersionDirs(version);
		}
	} catch {
		// Assets stay missing: themes fall back to defaults and webui reports
		// its assets as missing instead of crashing the CLI.
	}
}

function bootstrapSidecarRoot(): void {
	// Mirrors getAgentDir()/getBinDir() in config.ts, which cannot be imported
	// here (see module comment). The env override name is stable API.
	const agentDir = process.env.NANOPI_CODING_AGENT_DIR ?? join(homedir(), ".nanopi", "agent");
	process.env.NANOPI_TUI_NATIVE_ROOT ??= join(agentDir, "bin", "native", "tui");
}

if (isSingleNodeFileRuntime()) {
	bootstrapEmbeddedAssets();
	bootstrapSidecarRoot();
}
