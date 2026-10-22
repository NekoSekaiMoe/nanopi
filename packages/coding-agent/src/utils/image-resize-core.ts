import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 2000
	maxHeight?: number; // Default: 2000
	maxBytes?: number; // Default: 4.5MB of base64 payload (below Anthropic's 5MB limit)
	jpegQuality?: number; // Default: 80
}

/**
 * Why `resizeImageInProcess` produced no image. Callers use this to tell "the image is too large"
 * apart from "the image backend is unavailable", which need different user-facing messages.
 */
export type ImageResizeFailureReason = "photon-unavailable" | "decode-failed" | "too-large";

export type ImageResizeResult = { ok: true; image: ResizedImage } | { ok: false; reason: ImageResizeFailureReason };

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

/**
 * Tag on image resize worker replies. Node can post its own messages on the worker channel
 * (for example `{ "watch:require": [...] }` under `node --watch`), so replies must be identifiable.
 */
export const IMAGE_RESIZE_WORKER_RESPONSE_TYPE = "nanopi:image-resize-response";

export type ResizeImageWorkerResponse =
	| { type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE; result: ImageResizeResult }
	| { type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE; error: string };

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns the failure reason instead of null when no image is produced.
 *
 * Uses Photon (Rust/WASM) for image processing. If Photon is not available,
 * fails with `photon-unavailable`.
 *
 * Strategy for staying under maxBytes:
 * 1. First resize to maxWidth/maxHeight
 * 2. Try both PNG and JPEG formats, pick the smaller one
 * 3. If still too large, try JPEG with decreasing quality
 * 4. If still too large, progressively reduce dimensions until 1x1
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ImageResizeResult> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	const photon = await loadPhoton();
	if (!photon) {
		return { ok: false, reason: "photon-unavailable" };
	}

	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const format = mimeType.split("/")[1] ?? "png";

		// Check if already within all limits (dimensions AND encoded size)
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
			return {
				ok: true,
				image: {
					data: Buffer.from(inputBytes).toString("base64"),
					mimeType: mimeType || `image/${format}`,
					originalWidth,
					originalHeight,
					width: originalWidth,
					height: originalHeight,
					wasResized: false,
				},
			};
		}

		// Calculate initial dimensions respecting max limits
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		function tryEncodings(width: number, height: number, jpegQualities: number[]): EncodedCandidate[] {
			const resized = photon!.resize(image!, width, height, photon!.SamplingFilter.Lanczos3);

			try {
				const candidates: EncodedCandidate[] = [encodeCandidate(resized.get_bytes(), "image/png")];
				for (const quality of jpegQualities) {
					candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"));
				}
				return candidates;
			} finally {
				resized.free();
			}
		}

		const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		let currentWidth = targetWidth;
		let currentHeight = targetHeight;

		while (true) {
			const candidates = tryEncodings(currentWidth, currentHeight, qualitySteps);
			for (const candidate of candidates) {
				if (candidate.encodedSize < opts.maxBytes) {
					return {
						ok: true,
						image: {
							data: candidate.data,
							mimeType: candidate.mimeType,
							originalWidth,
							originalHeight,
							width: currentWidth,
							height: currentHeight,
							wasResized: true,
						},
					};
				}
			}

			if (currentWidth === 1 && currentHeight === 1) {
				break;
			}

			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
			if (nextWidth === currentWidth && nextHeight === currentHeight) {
				break;
			}

			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}

		return { ok: false, reason: "too-large" };
	} catch {
		return { ok: false, reason: "decode-failed" };
	} finally {
		if (image) {
			image.free();
		}
	}
}
