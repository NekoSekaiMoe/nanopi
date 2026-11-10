import { beforeEach, describe, expect, it } from "vitest";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/** Strip every SGR sequence so assertions compare plain text, not styling. */
function plain(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** A rendered diff line as plain text, with the inverse markers removed but the spacing kept. */
function lineText(line: string): string {
	return line.replace(/\x1b\[7m|\x1b\[27m/g, "");
}

/** The diff lines renderDiff emits, without hunk headers. */
function renderedLines(diff: string): string[] {
	return renderDiff(diff)
		.split("\n")
		.filter((line) => !line.includes("@@"))
		.map((line) => lineText(plain(line)));
}

const INDENTED_PAIR = `@@ -83,1 +83,1 @@
-83   await commitRecordingChunk({
+83     await commitRecordingChunk({
 context`;

describe("renderDiff indentation", () => {
	beforeEach(() => {
		initTheme();
	});

	it("keeps the indentation of the removed line", () => {
		const lines = renderedLines(INDENTED_PAIR);
		expect(lines[0]).toBe("-83   await commitRecordingChunk({");
		expect(lines[1]).toBe("+83     await commitRecordingChunk({");
	});

	it("keeps indentation when only the body changed", () => {
		const diff = `@@ -1,1 +1,1 @@
-1   const value = 1;
+1   const value = 2;`;
		const lines = renderedLines(diff);
		expect(lines[0]).toBe("-1   const value = 1;");
		expect(lines[1]).toBe("+1   const value = 2;");
	});

	it("does not invent indentation when neither line has it", () => {
		const diff = `@@ -1,1 +1,1 @@
-1 const a = 1;
+1 const b = 2;`;
		const lines = renderedLines(diff);
		expect(lines[0]).toBe("-1 const a = 1;");
		expect(lines[1]).toBe("+1 const b = 2;");
	});
});
