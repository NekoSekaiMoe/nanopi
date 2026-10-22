import { describe, expect, it, vi } from "vitest";
import { processImage } from "../src/utils/image-process.ts";
import { detectSupportedImageMimeType } from "../src/utils/mime.ts";
import * as photon from "../src/utils/photon.ts";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

function createTinyBmp1x1Red24bpp(): Buffer {
	const buffer = Buffer.alloc(58);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(1, 18);
	buffer.writeInt32LE(1, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(0, 30);
	buffer.writeUInt32LE(4, 34);
	buffer[56] = 0xff;
	return buffer;
}

function expectPngMagic(base64Data: string): void {
	const buffer = Buffer.from(base64Data, "base64");
	expect(buffer[0]).toBe(0x89);
	expect(buffer[1]).toBe(0x50);
	expect(buffer[2]).toBe(0x4e);
	expect(buffer[3]).toBe(0x47);
}

describe("image processing pipeline", () => {
	it.each(["GIF87a", "GIF89a"])("detects the complete %s signature", (signature) => {
		expect(detectSupportedImageMimeType(Buffer.from(signature, "ascii"))).toBe("image/gif");
	});

	it("detects BMP files from magic bytes", () => {
		expect(detectSupportedImageMimeType(createTinyBmp1x1Red24bpp())).toBe("image/bmp");
	});

	it("converts BMP files to PNG attachments when auto-resize is disabled", async () => {
		const result = await processImage(createTinyBmp1x1Red24bpp(), "image/bmp", { autoResizeImages: false });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mimeType).toBe("image/png");
		expect(result.hints).toContain("[Image converted from image/bmp to image/png.]");
		expectPngMagic(result.data);
	});

	it("converts BMP files before auto-resizing", async () => {
		const result = await processImage(createTinyBmp1x1Red24bpp(), "image/bmp");

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.mimeType).toBe("image/png");
		expect(result.hints).toContain("[Image converted from image/bmp to image/png.]");
		expectPngMagic(result.data);
	});

	it("blames the missing image backend instead of the format when nothing can decode", async () => {
		// A format with no passthrough support needs photon to convert; without it the failure is
		// about the backend, not the format.
		vi.spyOn(photon, "loadPhoton").mockResolvedValue(null);
		try {
			const result = await processImage(createTinyBmp1x1Red24bpp(), "image/bmp");

			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.reason).toBe("photon-unavailable");
			expect(result.message).toContain("image backend is unavailable");
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("reports too-large with the byte budget when resizing cannot reach the limit", async () => {
		const result = await processImage(TINY_PNG, "image/png", { resizeOptions: { maxBytes: 1 } });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("too-large");
		expect(result.message).toContain("limit of 1 bytes");
	});
});
