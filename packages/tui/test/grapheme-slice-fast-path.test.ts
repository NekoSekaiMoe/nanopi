import assert from "node:assert";
import { describe, it } from "node:test";
import { extractSegments, getGraphemeCellRange, sliceWithWidth } from "../src/utils.ts";

describe("grapheme slice fast path", () => {
	it("maps ASCII columns without grapheme segmentation", () => {
		const line = `\x1b[31mabcde\x1b[39m 中`;

		assert.deepStrictEqual(getGraphemeCellRange(line, 0), { start: 0, end: 1 });
		assert.deepStrictEqual(getGraphemeCellRange(line, 4), { start: 4, end: 5 });
		assert.deepStrictEqual(getGraphemeCellRange(line, 6), { start: 6, end: 8 });
		assert.deepStrictEqual(getGraphemeCellRange(line, 7), { start: 6, end: 8 });
		assert.strictEqual(getGraphemeCellRange(line, 8), undefined);
	});

	it("slices mixed ASCII and wide graphemes by visible column", () => {
		const line = "abcd让EFGH";

		assert.strictEqual(sliceWithWidth(line, 0, 5, true).text, "abcd");
		assert.strictEqual(sliceWithWidth(line, 5, 2, true).text, "E");
		assert.strictEqual(sliceWithWidth(line, 4, 3).text, "让E");
		assert.strictEqual(sliceWithWidth(line, 6, 3).text, "EFG");
	});

	it("slices ASCII chunks around ANSI codes with pending styles", () => {
		const line = "\x1b[32mfoo\x1b[39m bar";

		assert.strictEqual(sliceWithWidth(line, 3, 4, true).text, "\x1b[32m\x1b[39m bar");
		assert.strictEqual(sliceWithWidth(line, 4, 3, true).text, "\x1b[32m\x1b[39mbar");
		assert.strictEqual(sliceWithWidth(line, -4, 3).text, "");
	});

	it("extracts ASCII segments with inherited styling", () => {
		const line = "\x1b[32mabcdef\x1b[39m";

		const segments = extractSegments(line, 2, 5, 3, true);
		assert.strictEqual(segments.before, "\x1b[32mab");
		assert.strictEqual(segments.beforeWidth, 2);
		assert.strictEqual(segments.after, "\x1b[32mf\x1b[39m");
		assert.strictEqual(segments.afterWidth, 1);
	});
});
