import { beforeEach, describe, expect, it } from "vitest";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/** Strip every SGR sequence so assertions compare plain text, not styling. */
function plain(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

function renderedLines(diff: string): string[] {
	return renderDiff(diff)
		.split("\n")
		.filter((line) => !line.includes("@@"))
		.map((line) => plain(line).replace(/\x1b\[7m|\x1b\[27m/g, ""));
}

// `parseDiffLine` used `/^([+-\s])(\s*\d*)\s(.*)$/`, which has two ways to split a
// whitespace run and so backtracked once per split point: a 100k-space prefix froze
// the renderer for seconds. It also accepted `\r`/`\u2028` into a rendered line.
describe("diff line parsing", () => {
	beforeEach(() => {
		initTheme();
	});

	it("renders a line with a 100k-space prefix in linear time", () => {
		const diff = `@@ -1,1 +1,1 @@\n ${" ".repeat(100_000)}content`;
		const started = Date.now();
		const lines = renderedLines(diff);
		expect(Date.now() - started).toBeLessThan(1000);
		expect(lines).toHaveLength(1);
	});

	it("keeps prefix, line number, and content aligned", () => {
		const diff = `@@ -1,2 +1,2 @@\n-12 removed\n+13 added`;
		expect(renderedLines(diff)).toEqual(["-12 removed", "+13 added"]);
	});

	it("treats context lines and hunk headers without a line number as parsed rows", () => {
		// "     ..." is how a context row with no number is shown; it parses with an
		// empty line number, so the content keeps its own leading spaces.
		expect(renderedLines(`@@ -1,1 +1,1 @@\n     ...`)).toEqual(["     ..."]);
	});

	it("degrades a line carrying a raw carriage return to a context row", () => {
		const lines = renderedLines(`@@ -1,1 +1,1 @@\n+1 with\rreturn`);
		expect(lines).toEqual(["+1 with\rreturn"]);
	});

	it("degrades a line carrying a line separator to a context row", () => {
		const lines = renderedLines(`@@ -1,1 +1,1 @@\n-1 split\u2028here`);
		expect(lines).toEqual(["-1 split\u2028here"]);
	});

	it("passes through lines that are not diff rows", () => {
		expect(renderedLines("x no prefix")).toEqual(["x no prefix"]);
	});
});
