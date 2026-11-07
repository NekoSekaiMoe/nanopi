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
	/**
	 * Tarball URLs in preference order: the first one that answers wins. The
	 * fork's TUI prebuilds live on GitHub Releases with an AtomGit mirror behind
	 * it, because either host is unreachable for some readers.
	 */
	urls: string[];
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
/**
 * Budget for the reachability probe that decides whether offline mode may
 * download. Offline mode is set for machines that cannot reach the hosts, so a
 * probe that hangs on a blackholed connection would stall startup for the whole
 * download budget; it gets one short attempt per host instead.
 */
const PROBE_TIMEOUT_MS = 4_000;

let manifest: SidecarManifest | undefined;
const inflightSources = new Map<string, Promise<void>>();
const reachableUrls = new Map<string, boolean>();

/**
 * Drops the memoized manifest. Exported for tests only: the manifest is a
 * build-time constant, so nothing in the runtime has a reason to re-read it.
 */
export function resetSidecarManifestCache(): void {
	manifest = undefined;
}

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
	// `fetch` is typed against undici's `ReadableStream`, `Readable.fromWeb` takes
	// `node:stream/web`'s. They differ only in the BYOB reader's generic bound,
	// which no `fromWeb` caller can observe, so the cast is the whole seam.
	await pipeline(Readable.fromWeb(response.body as NodeWebReadableStream), createWriteStream(destPath));
}

/**
 * Downloads the first URL that answers. A failed candidate leaves nothing
 * behind: a partial file from a mirror that dropped mid-transfer must not be
 * extracted, and a stale one must not survive into the next attempt. Serial,
 * not racing — the later hosts exist because a host is unreachable for some
 * readers, not to be faster.
 */
async function downloadFirst(urls: string[], destPath: string): Promise<void> {
	const failures: string[] = [];
	for (const url of urls) {
		try {
			await downloadTo(url, destPath);
			return;
		} catch (error) {
			rmSync(destPath, { force: true });
			failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(failures.join("; "));
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

/**
 * Stops at the first configured host that answers. Ordered, not raced: the URLs
 * are a preference list, and the question is whether any of them is reachable
 * at all.
 */
async function anyHostAnswers(urls: string[]): Promise<boolean> {
	for (const url of urls) {
		if (await hostAnswers(url)) return true;
	}
	return false;
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
		await downloadFirst(source.urls, archivePath);
		mkdirSync(tempDir, { recursive: true });
		extractTarball(archivePath, tempDir);
		installSidecarFiles(tempDir, files, binDir);
	} finally {
		rmSync(archivePath, { force: true });
		rmSync(tempDir, { recursive: true, force: true });
	}
}

/**
 * Whether a tarball host answers at all.
 *
 * Offline mode means "this machine has no network", which is a guess about the
 * environment rather than a user preference: a container that sets it to keep a
 * startup offline still reaches the mirror, and refusing to fetch there is what
 * left every offline install without the photon wasm. Servers that do not
 * answer OPTIONS fall back to a ranged GET. Any HTTP status counts as reachable
 * — a 404 is a host that answered, and the download's own retry reports it.
 *
 * The answer is memoized per URL for the process lifetime: the probe runs once
 * per source per start, and the hosts do not change under a running process.
 */
async function hostAnswers(url: string): Promise<boolean> {
	const cached = reachableUrls.get(url);
	if (cached !== undefined) return cached;
	let reachable = false;
	try {
		// One attempt: the probe exists to time out, and a retry only doubles the wait.
		// An OPTIONS that the host answers with an error status still proves it is up.
		const response = await fetchWithRetry(
			url,
			{ method: "OPTIONS" },
			{ attemptTimeoutMs: PROBE_TIMEOUT_MS, maxRetries: 0 },
		);
		reachable = true;
		void response.body?.cancel().catch(() => undefined);
	} catch {
		reachable = false;
	}
	reachableUrls.set(url, reachable);
	return reachable;
}

/**
 * Ensures the sidecar files for this platform are installed. No-op when the
 * manifest is absent (npm installs) or when the requested files are already
 * present.
 *
 * Offline mode does not turn the download into a no-op: it only makes the hosts
 * prove they answer first (see `hostAnswers`). A `full` build embeds nothing —
 * both `sidecar/*` components are off — so "offline means no download" would
 * leave the wasm and the native prebuilds permanently missing on every machine
 * that sets the flag, which is what issue #586 walked into.
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

		if (isOfflineModeEnabled() && !(await anyHostAnswers(source.urls))) {
			options.onStatus?.({
				type: "warning",
				message: `Sidecars for ${source.packageName} missing; offline mode and no host answered.`,
			});
			continue;
		}

		const key = source.urls.join(" ");
		let inflight = inflightSources.get(key);
		if (!inflight) {
			inflight = installSource(source, wanted, options.onStatus).finally(() => inflightSources.delete(key));
			inflightSources.set(key, inflight);
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
