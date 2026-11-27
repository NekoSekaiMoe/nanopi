import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { getBinDir } from "../config.ts";

/**
 * Embedded sidecars for single-file distributions.
 *
 * Node cannot dlopen a native module from memory, so the TUI native
 * prebuilds and the photon wasm are packed into the bundle as gzip+base64 at
 * build time and installed into the agent bin directory at startup. Flavors
 * enabling the `sidecar/*` buildconfig components embed them; npm installs
 * have no embedded payload and resolve every payload through node_modules.
 *
 * Integrity model: every embedded file pins a sha256 computed at build time.
 * A corrupt payload or installed file is repaired from the embedded copy.
 */

/** Build-time injected builtin contents, only defined in single-file bundles. */
declare const NANOPI_BUILTIN_SIDECARS: string | undefined;

export type SidecarKind = "photon-wasm" | "tui-native";

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

function fileMatchesPlatform(file: Pick<BuiltinSidecarFile, "os" | "arch">): boolean {
	return (
		(file.os === undefined || file.os === process.platform) && (file.arch === undefined || file.arch === process.arch)
	);
}

function sha256OfFile(path: string): string | null {
	try {
		return createHash("sha256").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
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

/**
 * Ensures the embedded sidecar files for this platform are installed. No-op
 * when the bundle has no embedded payload (npm installs or flavors that
 * disable every `sidecar/*` component).
 */
export function installEmbeddedSidecars(onStatus?: (status: SidecarStatus) => void): void {
	const builtin = getBuiltinSidecars();
	if (!builtin) return;
	try {
		installBuiltinSidecarFiles(builtin.files, getBinDir());
	} catch (error) {
		onStatus?.({
			type: "warning",
			message: `Failed to install builtin sidecars: ${error instanceof Error ? error.message : String(error)}`,
		});
	}
}
