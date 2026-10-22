import { Worker } from "node:worker_threads";
import {
	IMAGE_RESIZE_WORKER_RESPONSE_TYPE,
	type ImageResizeOptions,
	type ImageResizeResult,
	type ResizedImage,
	type ResizeImageWorkerResponse,
	resizeImageInProcess,
} from "./image-resize-core.ts";

export type {
	ImageResizeFailureReason,
	ImageResizeOptions,
	ImageResizeResult,
	ResizedImage,
} from "./image-resize-core.ts";

/**
 * Worker startup/teardown failures already reported to the user. A single session resizing many
 * images would otherwise repeat the same fallback notice for every image.
 */
const reportedWorkerFailures = new Set<string>();

function reportWorkerFailureOnce(error: Error): void {
	const reason = error.message;
	if (reportedWorkerFailures.has(reason)) return;
	reportedWorkerFailures.add(reason);
	console.warn(`nanopi: image resize worker unavailable (${reason}); resizing images on the main thread instead.`);
}

function toTransferableBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	// Transfer detaches the buffer, so transfer a worker-owned copy and leave the
	// caller's bytes intact.
	return new Uint8Array(input);
}

function isResizeImageWorkerResponse(value: unknown): value is ResizeImageWorkerResponse {
	return (
		value !== null && typeof value === "object" && "type" in value && value.type === IMAGE_RESIZE_WORKER_RESPONSE_TYPE
	);
}

function createResizeWorker(workerSpecifier: string | URL): Worker {
	return new Worker(workerSpecifier);
}

async function resizeImageInWorker(
	workerSpecifier: string | URL,
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ImageResizeResult> {
	const worker = createResizeWorker(workerSpecifier);
	try {
		const inputBytesForWorker = toTransferableBytes(inputBytes);
		return await new Promise<ImageResizeResult>((resolve, reject) => {
			let settled = false;
			const settle = (result: ImageResizeResult): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			worker.on("message", (message: unknown) => {
				// Ignore messages Node posts on the worker channel itself, such as
				// `{ "watch:require": [...] }` under `node --watch` (nodejs/node#65044).
				if (!isResizeImageWorkerResponse(message)) return;
				if ("error" in message) fail(new Error(message.error));
				else settle(message.result);
			});
			worker.once("error", fail);
			worker.once("exit", (code) => {
				if (!settled) {
					fail(new Error(`Image resize worker exited with code ${code}`));
				}
			});
			worker.postMessage(
				{
					inputBytes: inputBytesForWorker,
					mimeType,
					options,
				},
				[inputBytesForWorker.buffer],
			);
		});
	} finally {
		void worker.terminate().catch(() => undefined);
	}
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Runs Photon in a worker thread so WASM decoding, resizing, and encoding do not
 * block the TUI event loop.
 *
 * The worker is a separate module on disk, so some layouts cannot load it: single-file
 * builds (`binaries/nanopi.js`, Bun compiled executables) ship one file with no worker
 * chunk next to it. When the worker fails to start or crashes, this falls back to
 * in-process resizing and warns once per distinct failure so the degraded mode is
 * visible instead of silent. A `null` result from the worker itself is a real resize
 * failure and is returned as-is, without falling back.
 */
export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ImageResizeResult> {
	const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
	const workerUrl = new URL(
		isTypeScriptRuntime ? "./image-resize-worker.ts" : "./image-resize-worker.js",
		import.meta.url,
	);

	try {
		return await resizeImageInWorker(workerUrl, inputBytes, mimeType, options);
	} catch (error) {
		reportWorkerFailureOnce(error instanceof Error ? error : new Error(String(error)));
		return resizeImageInProcess(inputBytes, mimeType, options);
	}
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}

	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
