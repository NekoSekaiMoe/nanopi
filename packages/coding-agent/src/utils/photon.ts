/**
 * Photon image processing wrapper.
 *
 * This module provides a unified interface to @silvia-odwyer/photon-node that works in:
 * 1. Node.js installs (development and npm packages, wasm next to the package)
 * 2. Single-file distributions (wasm downloaded as a sidecar into .nanopi/bin)
 *
 * The challenge: photon-node's CJS entry reads the wasm via
 * fs.readFileSync(__dirname + '/photon_rs_bg.wasm'), which only resolves inside
 * node_modules. Single-file bundles inline the JS but have no wasm on disk.
 *
 * Solution: patch fs.readFileSync to redirect missing photon_rs_bg.wasm reads
 * to sidecar locations under the agent bin directory.
 */

import type { PathOrFileDescriptor } from "fs";
import { createRequire } from "module";
import * as path from "path";
import { fileURLToPath } from "url";
import { getBinDir } from "../config.ts";
import { ensurePhotonWasmSidecar } from "./sidecars.ts";

const require = createRequire(import.meta.url);
const fs = require("fs") as typeof import("fs");

// Re-export types from the main package
export type { PhotonImage as PhotonImageType } from "@silvia-odwyer/photon-node";

type ReadFileSync = typeof fs.readFileSync;

const WASM_FILENAME = "photon_rs_bg.wasm";

// Lazy-loaded photon module
let photonModule: typeof import("@silvia-odwyer/photon-node") | null = null;
let loadPromise: Promise<typeof import("@silvia-odwyer/photon-node") | null> | null = null;

function pathOrNull(file: PathOrFileDescriptor): string | null {
	if (typeof file === "string") {
		return file;
	}
	if (file instanceof URL) {
		return fileURLToPath(file);
	}
	return null;
}

function getFallbackWasmPaths(): string[] {
	const execDir = path.dirname(process.execPath);
	return [
		path.join(getBinDir(), "photon", WASM_FILENAME),
		path.join(execDir, WASM_FILENAME),
		path.join(execDir, "photon", WASM_FILENAME),
		path.join(process.cwd(), WASM_FILENAME),
	];
}

function patchPhotonWasmRead(): () => void {
	const originalReadFileSync: ReadFileSync = fs.readFileSync.bind(fs);
	const fallbackPaths = getFallbackWasmPaths();
	const mutableFs = fs as { readFileSync: ReadFileSync };

	const patchedReadFileSync: ReadFileSync = ((...args: Parameters<ReadFileSync>) => {
		const [file, options] = args;
		const resolvedPath = pathOrNull(file);

		if (resolvedPath?.endsWith(WASM_FILENAME)) {
			try {
				return originalReadFileSync(...args);
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				if (err?.code && err.code !== "ENOENT") {
					throw error;
				}

				for (const fallbackPath of fallbackPaths) {
					if (!fs.existsSync(fallbackPath)) {
						continue;
					}
					if (options === undefined) {
						return originalReadFileSync(fallbackPath);
					}
					return originalReadFileSync(fallbackPath, options);
				}

				throw error;
			}
		}

		return originalReadFileSync(...args);
	}) as ReadFileSync;

	try {
		mutableFs.readFileSync = patchedReadFileSync;
	} catch {
		Object.defineProperty(fs, "readFileSync", {
			value: patchedReadFileSync,
			writable: true,
			configurable: true,
		});
	}

	return () => {
		try {
			mutableFs.readFileSync = originalReadFileSync;
		} catch {
			Object.defineProperty(fs, "readFileSync", {
				value: originalReadFileSync,
				writable: true,
				configurable: true,
			});
		}
	};
}

/**
 * Load the photon module asynchronously.
 * Returns cached module on subsequent calls.
 */
export async function loadPhoton(): Promise<typeof import("@silvia-odwyer/photon-node") | null> {
	if (photonModule) {
		return photonModule;
	}

	if (loadPromise) {
		return loadPromise;
	}

	loadPromise = (async () => {
		// Single-file bundles ship the wasm as a downloadable sidecar; make sure
		// it exists before the package's own readFileSync resolution runs.
		await ensurePhotonWasmSidecar();
		const restoreReadFileSync = patchPhotonWasmRead();
		try {
			photonModule = await import("@silvia-odwyer/photon-node");
			return photonModule;
		} catch {
			photonModule = null;
			return photonModule;
		} finally {
			restoreReadFileSync();
		}
	})();

	return loadPromise;
}
