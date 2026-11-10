import assert from "node:assert";
import { describe, it } from "node:test";
import { CURSOR_MARKER, FAKE_CURSOR_START } from "../src/tui.ts";
import { sliceByColumn, sliceWithWidth } from "../src/utils.ts";

// https://github.com/NekoSekaiMoe/nanopi/issues/640
describe("cursor marker isolation in column slices", () => {
	it("keeps a marker at its own column instead of the slice start", () => {
		const line = `\x1b[31mabc${CURSOR_MARKER}def\x1b[39m`;
		// The marker sits after column 2, so a slice starting at 2 must emit it after "c", not
		// before it. Rendering strips it later; the slice only has to keep the column right.
		const sliced = sliceByColumn(line, 2, 3);
		assert.strictEqual(sliced.replace(CURSOR_MARKER, ""), "\x1b[31mcde");
		assert.ok(!sliced.startsWith(CURSOR_MARKER), "marker moved to the slice start");
	});

	it("drops an APC marker that sits before the slice start", () => {
		const line = `${FAKE_CURSOR_START}hello world`;
		assert.strictEqual(sliceByColumn(line, 6, 5), "world");
	});

	it("keeps SGR styling that sits before the slice start", () => {
		const line = `\x1b[31mabc${CURSOR_MARKER}def\x1b[39m`;
		const { text, width } = sliceWithWidth(line, 4, 2);
		assert.strictEqual(text.replace(CURSOR_MARKER, ""), "\x1b[31mef");
		assert.strictEqual(width, 2);
	});

	it("distributes one marker to exactly one of the three slices", () => {
		const line = `\x1b[32mone ${CURSOR_MARKER}two three\x1b[39m`;
		const before = sliceByColumn(line, 0, 4, true);
		const selected = sliceByColumn(line, 4, 3, true);
		const after = sliceByColumn(line, 7, 100, true);
		const carriers = [before, selected, after].filter((part) => part.includes(CURSOR_MARKER));
		assert.strictEqual(carriers.length, 1);
		for (const part of [before, selected, after]) {
			assert.ok(!part.includes(FAKE_CURSOR_START), "fake cursor start must never be carried over");
		}
	});
});
