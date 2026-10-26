import assert from "node:assert";
import { describe, it } from "node:test";
import { clampScrollOffset, pageStep, windowStart } from "../src/pager.ts";

describe("pageStep", () => {
	it("moves by one page in both directions", () => {
		assert.equal(pageStep(4, 20, 1, { pageSize: 5, wrap: false }), 9);
		assert.equal(pageStep(9, 20, -1, { pageSize: 5, wrap: false }), 4);
	});

	it("stops at the ends when the list does not wrap", () => {
		assert.equal(pageStep(2, 20, -1, { pageSize: 5, wrap: false }), 0);
		assert.equal(pageStep(17, 20, 1, { pageSize: 5, wrap: false }), 19);
	});

	it("wraps past the ends when the list wraps", () => {
		assert.equal(pageStep(1, 8, -1, { pageSize: 3, wrap: true }), 6);
		assert.equal(pageStep(6, 8, 1, { pageSize: 3, wrap: true }), 1);
	});

	it("returns 0 for an empty list", () => {
		assert.equal(pageStep(3, 0, 1, { pageSize: 5, wrap: true }), 0);
		assert.equal(pageStep(3, 0, -1, { pageSize: 5, wrap: false }), 0);
	});

	it("falls back to 10 rows when the caller has no visible rows yet", () => {
		assert.equal(pageStep(0, 30, 1, { pageSize: 0, wrap: false }), 10);
	});
});

describe("windowStart", () => {
	it("centers the selection in the window", () => {
		assert.equal(windowStart(10, 40, 5), 8);
	});

	it("clamps to the ends instead of scrolling past them", () => {
		assert.equal(windowStart(0, 40, 5), 0);
		assert.equal(windowStart(39, 40, 5), 35);
	});

	it("returns 0 when the list is shorter than the window", () => {
		assert.equal(windowStart(2, 3, 10), 0);
	});
});

describe("clampScrollOffset", () => {
	it("keeps the last page full", () => {
		assert.equal(clampScrollOffset(100, 30, 10), 20);
	});

	it("never goes negative", () => {
		assert.equal(clampScrollOffset(-4, 30, 10), 0);
	});

	it("returns 0 when the content fits", () => {
		assert.equal(clampScrollOffset(5, 6, 10), 0);
	});
});
