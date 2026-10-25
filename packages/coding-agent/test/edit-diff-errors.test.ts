import { describe, expect, it } from "vitest";
import { applyEditsToNormalizedContent } from "../src/core/tools/edit-diff.ts";

function attempt(content: string, oldText: string, newText: string): string {
	try {
		applyEditsToNormalizedContent(content, [{ oldText, newText }], "file.ts");
		return "";
	} catch (error) {
		return (error as Error).message;
	}
}

describe("edit-diff error messages", () => {
	it("lists the file lines of every duplicate occurrence", () => {
		const content = ["const first = 1;", "middle();", "const first = 1;", "tail();"].join("\n");
		const message = attempt(content, "const first = 1;", "const first = 2;");
		expect(message).toContain("Found 2 occurrences");
		expect(message).toContain("line 1: const first = 1;");
		expect(message).toContain("line 3: const first = 1;");
	});

	it("names the called-out edit index for multi-edit duplicates", () => {
		const content = ["a();", "b();", "a();"].join("\n");
		try {
			applyEditsToNormalizedContent(
				content,
				[
					{ oldText: "b();", newText: "c();" },
					{ oldText: "a();", newText: "d();" },
				],
				"file.ts",
			);
			expect.unreachable("expected a duplicate error");
		} catch (error) {
			expect((error as Error).message).toContain("edits[1]");
		}
	});

	it("suggests the closest lines when the text is missing", () => {
		const content = [
			"export function loadConfig() {",
			"  return readSettings();",
			"}",
			"",
			"export function saveConfig() {",
			"  return writeSettings();",
			"}",
		].join("\n");
		const message = attempt(content, "export function loadConfig() {\n  return readSetting();", "x();");
		expect(message).toContain("Could not find the exact text");
		expect(message).toContain("The closest lines in the file are:");
		expect(message).toContain("line 1: export function loadConfig() {");
		expect(message).toContain("line 2: return readSettings();");
	});

	it("ranks rare identifiers above boilerplate", () => {
		const content = [
			"if (ready) {",
			"  applyTheme(currentTheme);",
			"  if (ready) {",
			"    applyTheme(previousTheme);",
			"  }",
		].join("\n");
		const message = attempt(content, "applyTheme(preferredTheme);", "applyTheme(nextTheme);");
		const closest = message.slice(message.indexOf("The closest lines in the file are:"));
		// Both `applyTheme` lines are candidates; the first reported one must be one of them.
		expect(closest).toContain("applyTheme(");
		expect(closest).not.toContain("line 1: if (ready) {");
	});

	it("omits the suggestion block when nothing shares an identifier", () => {
		const content = "alpha();\nbeta();\n";
		const message = attempt(content, "zzz();", "yyy();");
		expect(message).toContain("Could not find the exact text");
		expect(message).not.toContain("closest lines in the file");
	});
});
