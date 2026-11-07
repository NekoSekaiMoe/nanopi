import { getImageDimensions } from "@nanopi/pi-tui";
import { convertImageBytesToPng } from "./image-convert.ts";
import {
	formatDimensionNote,
	type ImageResizeFailureReason,
	type ImageResizeOptions,
	resizeImage,
} from "./image-resize.ts";
import { resolveImageResizeOptions } from "./image-resize-core.ts";
import { loadPhoton } from "./photon.ts";

export interface ProcessImageOptions {
	/** Whether to resize images to inline provider limits. Default: true */
	autoResizeImages?: boolean;
	/** Optional resize overrides. Uses resizeImage defaults when omitted. */
	resizeOptions?: ImageResizeOptions;
}

export type ProcessImageFailureReason = "unsupported-format" | ImageResizeFailureReason;

export type ProcessImageResult =
	| {
			ok: true;
			data: string;
			mimeType: string;
			hints: string[];
	  }
	| {
			ok: false;
			reason: ProcessImageFailureReason;
			message: string;
	  };

interface NormalizedImage {
	bytes: Uint8Array;
	mimeType: string;
	convertedFrom?: string;
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function normalizeSupportedImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "image/png";
		case "image/jpeg":
		case "image/jpg":
			return "image/jpeg";
		case "image/gif":
			return "image/gif";
		case "image/webp":
			return "image/webp";
		default:
			return null;
	}
}

async function normalizeImage(bytes: Uint8Array, mimeType: string): Promise<NormalizedImage | null> {
	const normalizedMimeType = normalizeSupportedImageMimeType(mimeType);
	if (normalizedMimeType) {
		return { bytes, mimeType: normalizedMimeType };
	}

	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		bytes: pngBytes,
		mimeType: "image/png",
		convertedFrom: baseMimeType(mimeType),
	};
}

function conversionHint(from: string | undefined, to: string): string | undefined {
	if (!from || from === to) return undefined;
	return `[Image converted from ${from} to ${to}.]`;
}

/**
 * Whether an unprocessed image is already safe to inline.
 *
 * Photon is the only thing here that can shrink an image, so when it is missing the
 * choice is between sending the original bytes and dropping the image. Dropping wins
 * when the image breaks a limit the provider would reject the whole request over;
 * one that already fits is better sent unresized than not sent at all.
 *
 * Both limits the resize path enforces are checked: the base64 payload budget and the
 * pixel bounds. A byte-small but huge image would pass a payload check and still be
 * refused, which is the failure mode the resize stage exists to prevent.
 */
function fitsInlineLimits(bytes: Uint8Array, mimeType: string, options: ImageResizeOptions | undefined): boolean {
	const limits = resolveImageResizeOptions(options);
	// `4 * ceil(n / 3)` is exactly what `Buffer.toString("base64")` produces.
	if (Math.ceil(bytes.byteLength / 3) * 4 >= limits.maxBytes) return false;
	const dimensions = getImageDimensions(Buffer.from(bytes).toString("base64"), mimeType);
	// An unreadable header is not evidence of an oversized image; the four formats that
	// reach this point all parse, so a null here means the bytes are already broken and
	// sending them costs one failed request instead of silently hiding the file.
	return dimensions === null || (dimensions.widthPx <= limits.maxWidth && dimensions.heightPx <= limits.maxHeight);
}

function resizeFailureMessage(reason: ImageResizeFailureReason, maxBytes: number | undefined): string {
	switch (reason) {
		case "photon-unavailable":
			return "[Image omitted: the image backend is unavailable, so the image could not be resized.]";
		case "decode-failed":
			return "[Image omitted: the image could not be decoded for resizing.]";
		case "too-large":
			return maxBytes === undefined
				? "[Image omitted: could not be resized below the inline image size limit.]"
				: `[Image omitted: could not be resized below the inline image size limit of ${maxBytes} bytes.]`;
	}
}

export async function processImage(
	bytes: Uint8Array,
	mimeType: string,
	options?: ProcessImageOptions,
): Promise<ProcessImageResult> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const normalized = await normalizeImage(bytes, mimeType);
	if (!normalized) {
		// Converting a format we cannot pass through needs Photon; when it is missing the
		// message should say so rather than blame the image format.
		const reason: ProcessImageFailureReason = (await loadPhoton()) ? "unsupported-format" : "photon-unavailable";
		return {
			ok: false,
			reason,
			message:
				reason === "unsupported-format"
					? "[Image omitted: could not be converted to a supported inline image format.]"
					: resizeFailureMessage("photon-unavailable", undefined),
		};
	}

	if (autoResizeImages) {
		const result = await resizeImage(normalized.bytes, normalized.mimeType, options?.resizeOptions);
		if (!result.ok) {
			// Nothing here can re-encode an image without Photon, so "the backend is missing"
			// is not a reason to throw the image away when it already satisfies the limits.
			// EXIF orientation goes unapplied on this path; a rotated image the model can still
			// see beats an omitted one, and the hint says what was skipped.
			if (
				result.reason === "photon-unavailable" &&
				fitsInlineLimits(normalized.bytes, normalized.mimeType, options?.resizeOptions)
			) {
				const hints = passThroughHints(normalized);
				hints.push("[Image not resized: the image backend is unavailable, so the image was sent as-is.]");
				return {
					ok: true,
					data: Buffer.from(normalized.bytes).toString("base64"),
					mimeType: normalized.mimeType,
					hints,
				};
			}
			return {
				ok: false,
				reason: result.reason,
				message: resizeFailureMessage(result.reason, options?.resizeOptions?.maxBytes),
			};
		}
		const resized = result.image;

		const hints: string[] = [];
		const convertedHint = conversionHint(normalized.convertedFrom, resized.mimeType);
		if (convertedHint) hints.push(convertedHint);
		const dimensionNote = formatDimensionNote(resized);
		if (dimensionNote) hints.push(dimensionNote);

		return {
			ok: true,
			data: resized.data,
			mimeType: resized.mimeType,
			hints,
		};
	}

	return {
		ok: true,
		data: Buffer.from(normalized.bytes).toString("base64"),
		mimeType: normalized.mimeType,
		hints: passThroughHints(normalized),
	};
}

/** Hints for an image that goes into the conversation without being re-encoded. */
function passThroughHints(normalized: NormalizedImage): string[] {
	const hints: string[] = [];
	const convertedHint = conversionHint(normalized.convertedFrom, normalized.mimeType);
	if (convertedHint) hints.push(convertedHint);
	return hints;
}
