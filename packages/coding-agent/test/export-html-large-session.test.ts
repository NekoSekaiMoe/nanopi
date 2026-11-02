import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

// A session tree is one long chain, so a recursive tree walk has depth equal to the entry
// count and blows the stack on a large session: the page renders nothing at all.
describe("export HTML tree walks", () => {
	it("sorts children without recursing per tree level", () => {
		expect(templateJs).not.toMatch(/node\.children\.forEach\(sortChildren\)/);
		expect(templateJs).toMatch(/const toSort = \[\.\.\.roots\];/);
	});

	it("marks active subtrees without recursing per tree level", () => {
		expect(templateJs).not.toMatch(/if \(markActive\(child\)\)/);
		expect(templateJs).toMatch(/const pending = \[\];/);
	});
});
