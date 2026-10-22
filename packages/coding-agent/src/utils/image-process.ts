import { convertImageBytesToPng } from "./image-convert.ts";
import {
	formatDimensionNote,
	type ImageResizeFailureReason,
	type ImageResizeOptions,
	resizeImage,
} from "./image-resize.ts";
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

	const hints: string[] = [];
	const convertedHint = conversionHint(normalized.convertedFrom, normalized.mimeType);
	if (convertedHint) hints.push(convertedHint);

	return {
		ok: true,
		data: Buffer.from(normalized.bytes).toString("base64"),
		mimeType: normalized.mimeType,
		hints,
	};
}
