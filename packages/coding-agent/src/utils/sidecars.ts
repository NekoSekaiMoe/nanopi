import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { gunzipSync } from "node:zlib";
import { getBinDir } from "../config.ts";
import { fetchWithRetry } from "./management-http.ts";
import { isOfflineModeEnabled } from "./tools-manager.ts";

/**
 * Sidecars for single-file distributions.
 *
 * The single-file nanopi.js bundles all JavaScript but not platform payloads:
 * the photon wasm (image resizing) and the TUI native prebuilds (clipboard,
 * key modifiers). Node cannot dlopen a native module from memory, so these
 * must exist as files in the agent bin directory. Flavors enabling the
 * `sidecar/*` buildconfig components embed the contents in the bundle and
 * install them with the same sha256 verification, no network involved;
 * disabled components (and corrupt embeds) fall back to downloading tarballs
 * pinned by the manifest. In npm installs every payload resolves through
 * node_modules and both payloads are absent, so all functions here are no-ops.
 *
 * Integrity model: builtin files and manifest tarballs alike pin a sha256 per
 * file. Any byte difference from the files hashed at build time fails
 * verification and is discarded.
 */

/** Build-time injected manifest, only defined in single-file bundles. */
declare const NANOPI_SIDECARS: string | undefined;
/** Build-time injected builtin contents, only defined in single-file bundles. */
declare const NANOPI_BUILTIN_SIDECARS: string | undefined;

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

/** A sidecar file with its content embedded in the bundle. */
export interface BuiltinSidecarFile {
	kind: SidecarKind;
	/** Path relative to the agent bin directory. */
	destPath: string;
	/** Hex sha256 of the file content, computed at build time. */
	sha256: string;
	bytes: number;
	/** Base64-encoded file content. */
	content: string;
	/** Only install when process.platform matches. Omit for universal files. */
	os?: string;
	/** Only install when process.arch matches. Omit for universal files. */
	arch?: string;
}

export interface BuiltinSidecarPayload {
	files: BuiltinSidecarFile[];
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

function fileMatchesPlatform(file: Pick<SidecarFile, "os" | "arch">): boolean {
	return (
		(file.os === undefined || file.os === process.platform) && (file.arch === undefined || file.arch === process.arch)
	);
}

/**
 * Returns the embedded builtin sidecars, or undefined outside single-file
 * bundles (or when the flavor disabled every `sidecar/*` component, which
 * packs an empty file list that callers treat as absent).
 */
export function getBuiltinSidecars(): BuiltinSidecarPayload | undefined {
	try {
		if (typeof NANOPI_BUILTIN_SIDECARS === "undefined") return undefined;
		const payload = JSON.parse(
			gunzipSync(Buffer.from(NANOPI_BUILTIN_SIDECARS, "base64")).toString("utf8"),
		) as BuiltinSidecarPayload;
		return payload.files.length > 0 ? payload : undefined;
	} catch {
		return undefined;
	}
}

function builtinFileIsInstalled(file: BuiltinSidecarFile, binDir: string): boolean {
	const destPath = join(binDir, file.destPath);
	try {
		const stats = statSync(destPath);
		if (!stats.isFile() || stats.size !== file.bytes) return false;
	} catch {
		return false;
	}
	return sha256OfFile(destPath) === file.sha256;
}

/**
 * Installs embedded sidecar files into binDir. Skips files that are already
 * installed with a matching checksum and files for other platforms.
 * Exported for tests; throws on the first checksum mismatch.
 */
export function installBuiltinSidecarFiles(files: BuiltinSidecarFile[], binDir: string): void {
	mkdirSync(binDir, { recursive: true });
	for (const file of files) {
		if (!fileMatchesPlatform(file)) continue;
		if (builtinFileIsInstalled(file, binDir)) continue;
		const content = Buffer.from(file.content, "base64");
		if (content.byteLength !== file.bytes) {
			throw new Error(`builtin sidecar size mismatch for ${file.destPath}`);
		}
		const hash = createHash("sha256").update(content).digest("hex");
		if (hash !== file.sha256) {
			throw new Error(`builtin sidecar checksum mismatch for ${file.destPath}`);
		}
		const destPath = join(binDir, file.destPath);
		mkdirSync(dirname(destPath), { recursive: true });
		const stagedPath = `${destPath}.staged-${process.pid}`;
		rmSync(stagedPath, { force: true });
		writeFileSync(stagedPath, content);
		renameSync(stagedPath, destPath);
	}
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
	// WHATWG streams come from two declaration sets here: `fetch` is typed with
	// undici's `ReadableStream`, `Readable.fromWeb` wants `node:stream/web`'s.
	// They disagree only on the BYOB reader's generic bound, so name the type.
	await pipeline(Readable.fromWeb(response.body as unknown as NodeWebReadableStream), createWriteStream(destPath));
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
	const builtin = getBuiltinSidecars();
	if (builtin) {
		const wanted = builtin.files.filter(
			(file) => fileMatchesPlatform(file) && (options.kind === undefined || file.kind === options.kind),
		);
		if (wanted.length > 0) {
			try {
				installBuiltinSidecarFiles(wanted, getBinDir());
			} catch (error) {
				options.onStatus?.({
					type: "warning",
					message: `Failed to install builtin sidecars: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}
	}

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
