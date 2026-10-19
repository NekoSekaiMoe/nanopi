import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Single-file bundle bootstrap: extract embedded package assets.
 *
 * The single-file nanopi.js inlines the JavaScript graph but the CLI still
 * reads data files by path (HTML export templates, webui, docs,
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

/** Marker recording the payload hash of the last extraction. Same-version rebuilds change the payload without changing the version directory, so the hash is what detects stale trees. */
export const ASSETS_HASH_MARKER = ".assets-sha256";

/** True only in single-file bundles; false everywhere else (npm, source checkout). */
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
 * never leaves a half-written tree that later looks installed. When
 * payloadHash is given it is recorded inside the staged tree so the finished
 * directory proves which payload produced it.
 */
export function extractAssetsPayload(payloadBase64: string, targetDir: string, payloadHash?: string): void {
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
		if (payloadHash !== undefined) {
			writeFileSync(join(stagingDir, ASSETS_HASH_MARKER), `${payloadHash}\n`);
		}
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

function readMarkerLine(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return undefined;
	}
}

/**
 * Brings targetDir in sync with the payload: extracts when the tree is
 * missing, incomplete, or was extracted from a different payload (same
 * version, rebuilt content). Returns whether a complete tree is present.
 */
export function syncAssetsPayload(payloadBase64: string, targetDir: string): boolean {
	const payloadHash = createHash("sha256").update(payloadBase64).digest("hex");
	try {
		const complete = existsSync(join(targetDir, ASSETS_COMPLETE_MARKER));
		const extractedHash = complete ? readMarkerLine(join(targetDir, ASSETS_HASH_MARKER)) : undefined;
		if (!complete || extractedHash !== payloadHash) {
			extractAssetsPayload(payloadBase64, targetDir, payloadHash);
		}
		return existsSync(join(targetDir, ASSETS_COMPLETE_MARKER));
	} catch {
		return false;
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
		if (syncAssetsPayload(payload, targetDir)) {
			// Respect a user-provided package dir; it wins over the cache.
			process.env.NANOPI_PACKAGE_DIR ??= targetDir;
			removeStaleVersionDirs(version);
		}
	} catch {
		// Assets stay missing: webui reports its assets as missing instead of
		// crashing the CLI.
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
