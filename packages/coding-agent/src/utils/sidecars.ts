import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getBinDir } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";
import { isOfflineModeEnabled } from "./tools-manager.ts";

/**
 * Sidecar downloads for single-file distributions.
 *
 * The single-file nanopi.js bundles all JavaScript but not platform payloads:
 * the photon wasm (image resizing) and the TUI native prebuilds (clipboard,
 * key modifiers). Those are downloaded from the npm registry into the agent
 * bin directory (".nanopi/bin") and verified against sha256 hashes embedded in
 * the bundle at build time. In npm installs every payload resolves through
 * node_modules and the manifest is absent, so all functions here are no-ops.
 *
 * Integrity model: the manifest pins the tarball URL (package@version) plus a
 * sha256 per extracted file. Any byte difference between the registry tarball
 * and the files hashed at build time fails verification and is discarded.
 */

/** Build-time injected manifest, only defined in single-file bundles. */
declare const NANOPI_SIDECARS: string | undefined;

export type SidecarKind = "photon-wasm" | "tui-native";

export interface SidecarFile {
	kind: SidecarKind;
	/** Path inside the registry tarball, e.g. "package/photon_rs_bg.wasm". */
	tarPath: string;
	/** Path relative to the agent bin directory. */
	destPath: string;
	/** Hex sha256 of the file content, computed at build time. */
	sha256: string;
	bytes: number;
	/** Only install when process.platform matches. Omit for universal files. */
	os?: string;
	/** Only install when process.arch matches. Omit for universal files. */
	arch?: string;
}

export interface SidecarSource {
	/** npm package name, e.g. "@silvia-odwyer/photon-node". */
	packageName: string;
	version: string;
	/** Registry tarball URL. */
	url: string;
	files: SidecarFile[];
}

export interface SidecarManifest {
	sources: SidecarSource[];
}

export type SidecarStatus = { type: "info" | "warning"; message: string };

const DOWNLOAD_TIMEOUT_MS = 120_000;

let manifest: SidecarManifest | undefined;
const inflightSources = new Map<string, Promise<void>>();

/** Returns the embedded sidecar manifest, or undefined outside single-file bundles. */
export function getSidecarManifest(): SidecarManifest | undefined {
	manifest ??= typeof NANOPI_SIDECARS === "undefined" ? undefined : (JSON.parse(NANOPI_SIDECARS) as SidecarManifest);
	return manifest;
}

function fileMatchesPlatform(file: SidecarFile): boolean {
	return (
		(file.os === undefined || file.os === process.platform) && (file.arch === undefined || file.arch === process.arch)
	);
}

function fileIsInstalled(file: SidecarFile): boolean {
	try {
		const stats = statSync(join(getBinDir(), file.destPath));
		return stats.isFile() && stats.size === file.bytes;
	} catch {
		return false;
	}
}

function sha256OfFile(path: string): string | null {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
}

function extractTarball(archivePath: string, extractDir: string): void {
	// npm tarballs are gzipped tar archives; every supported platform ships a
	// compatible tar (Windows via System32 bsdtar, same as the fd/rg tool
	// downloads in tools-manager).
	const tar =
		process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
	const result = spawnSync(tar, ["xzf", archivePath, "-C", extractDir], { stdio: "pipe" });
	if (result.error || result.status !== 0) {
		const detail = result.error
			? result.error.message
			: (result.stderr?.toString().trim() ?? `exit ${result.status}`);
		throw new Error(`tar extraction failed: ${detail}`);
	}
}

async function downloadTo(url: string, destPath: string): Promise<void> {
	const response = await fetchWithRetry(url, undefined, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
	if (!response.ok || !response.body) {
		throw new Error(`download failed: HTTP ${response.status} for ${url}`);
	}
	await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), createWriteStream(destPath));
}

/**
 * Verifies and moves the wanted files from an extracted tarball into binDir.
 * Exported for tests; throws on the first checksum mismatch.
 */
export function installSidecarFiles(extractDir: string, files: SidecarFile[], binDir: string): void {
	for (const file of files) {
		const extractedPath = join(extractDir, file.tarPath);
		if (!existsSync(extractedPath)) {
			throw new Error(`sidecar file missing from tarball: ${file.tarPath}`);
		}
		const hash = sha256OfFile(extractedPath);
		if (hash !== file.sha256) {
			throw new Error(`sidecar checksum mismatch for ${file.tarPath}: expected ${file.sha256}, got ${hash}`);
		}
		const destPath = join(binDir, file.destPath);
		mkdirSync(dirname(destPath), { recursive: true });
		const stagedPath = `${destPath}.staged-${process.pid}`;
		rmSync(stagedPath, { force: true });
		renameSync(extractedPath, stagedPath);
		renameSync(stagedPath, destPath);
	}
}

async function installSource(
	source: SidecarSource,
	files: SidecarFile[],
	onStatus?: (s: SidecarStatus) => void,
): Promise<void> {
	const binDir = getBinDir();
	mkdirSync(binDir, { recursive: true });
	const tempDir = join(binDir, `.sidecar-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	const archivePath = `${tempDir}.tgz`;
	try {
		onStatus?.({ type: "info", message: `Downloading ${source.packageName}@${source.version} sidecars...` });
		await downloadTo(source.url, archivePath);
		mkdirSync(tempDir, { recursive: true });
		extractTarball(archivePath, tempDir);
		installSidecarFiles(tempDir, files, binDir);
	} finally {
		rmSync(archivePath, { force: true });
		rmSync(tempDir, { recursive: true, force: true });
	}
}

/**
 * Ensures the sidecar files for this platform are installed. No-op when the
 * manifest is absent (npm installs), when the requested files are already
 * present, or when offline mode is enabled.
 */
export async function ensureSidecars(
	options: { kind?: SidecarKind; onStatus?: (status: SidecarStatus) => void } = {},
): Promise<void> {
	const currentManifest = getSidecarManifest();
	if (!currentManifest) return;

	for (const source of currentManifest.sources) {
		const wanted = source.files.filter(
			(file) => fileMatchesPlatform(file) && (options.kind === undefined || file.kind === options.kind),
		);
		if (wanted.length === 0 || wanted.every(fileIsInstalled)) continue;

		if (isOfflineModeEnabled()) {
			options.onStatus?.({
				type: "warning",
				message: `Sidecars for ${source.packageName} missing; offline mode skips download.`,
			});
			continue;
		}

		let inflight = inflightSources.get(source.url);
		if (!inflight) {
			inflight = installSource(source, wanted, options.onStatus).finally(() => inflightSources.delete(source.url));
			inflightSources.set(source.url, inflight);
		}
		try {
			await inflight;
		} catch (error) {
			options.onStatus?.({
				type: "warning",
				message: `Failed to install ${source.packageName} sidecars: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}
}

let photonEnsure: Promise<void> | undefined;

/**
 * Ensures the photon wasm sidecar is present before photon loads. Called on
 * demand from the image pipeline; downloads at most once per process and
 * resolves even on failure so the caller can degrade to raw images.
 */
export function ensurePhotonWasmSidecar(onStatus?: (status: SidecarStatus) => void): Promise<void> {
	photonEnsure ??= ensureSidecars({ kind: "photon-wasm", onStatus }).catch(() => undefined);
	return photonEnsure;
}
