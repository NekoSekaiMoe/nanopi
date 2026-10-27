import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { applyEditsToNormalizedContent, normalizeForFuzzyMatch, normalizeToLF } from "../src/core/tools/edit-diff.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { clearReadSnapshot } from "../src/core/tools/read-snapshot.ts";

/**
 * `execute` takes signal/onUpdate/ctx positionally. The tools in these tests
 * resolve paths from their own `cwd` argument, so an empty context is enough.
 */
const noContext = {} as never;

function messageOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the call to throw");
}

describe("duplicate match error", () => {
	it("lists the line numbers instead of only a count", () => {
		const content = normalizeToLF("const a = 1;\nrun();\nconst b = 2;\nrun();\n");
		const message = messageOf(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "run();", newText: "stop();" }], "f.ts"),
		);
		expect(message).toContain("Found 2 occurrences");
		expect(message).toContain("line 2: run();");
		expect(message).toContain("line 4: run();");
	});

	it("names the failing edit when a call has several", () => {
		const content = normalizeToLF("a();\nunique();\nb();\nb();\n");
		const message = messageOf(() =>
			applyEditsToNormalizedContent(
				content,
				[
					{ oldText: "unique();", newText: "unique2();" },
					{ oldText: "b();", newText: "c();" },
				],
				"f.ts",
			),
		);
		expect(message).toContain("edits[1]");
		expect(message).toContain("line 3: b();");
		expect(message).toContain("line 4: b();");
	});

	it("counts duplicates in the same normalized space the match uses", () => {
		// Trailing whitespace and a smart quote differ from the needle, but the
		// fuzzy view makes both lines match, so both must be reported.
		const content = 'say(\u201chi\u201d);   \nsay("hi");\n';
		expect(normalizeForFuzzyMatch(content).match(/say\("hi"\);/g)).toHaveLength(2);
		const message = messageOf(() =>
			applyEditsToNormalizedContent(normalizeToLF(content), [{ oldText: 'say("hi");', newText: "x;" }], "f.ts"),
		);
		expect(message).toContain("Found 2 occurrences");
		expect(message).toContain("line 1:");
		expect(message).toContain("line 2:");
	});

	it("caps the listed occurrences so a common line stays readable", () => {
		const content = `${Array.from({ length: 9 }, () => "tick();").join("\n")}\n`;
		const message = messageOf(() =>
			applyEditsToNormalizedContent(normalizeToLF(content), [{ oldText: "tick();", newText: "tock();" }], "f.ts"),
		);
		expect(message).toContain("Found 9 occurrences");
		expect(message).toContain("and 4 more");
	});
});

describe("not-found error", () => {
	it("suggests the closest lines by shared tokens", () => {
		const content = normalizeToLF(
			["import fs from 'node:fs';", "const out = [];", "await writeFile(target, out.join(''));", "return out;"].join(
				"\n",
			),
		);
		const message = messageOf(() =>
			applyEditsToNormalizedContent(
				content,
				[{ oldText: "await writeFile(destination, out.join(''));", newText: "await writeFile(destination, x);" }],
				"f.ts",
			),
		);
		expect(message).toContain("Could not find the exact text");
		expect(message).toContain("The closest lines in the file are:");
		expect(message).toContain("line 3: await writeFile(target, out.join(''));");
	});

	it("does not use substring noise as a signal", () => {
		// A lone `}` shares no token with the needle, so it must not crowd out
		// the line that actually resembles it.
		const content = normalizeToLF(["function a() {", "}", "}", "}", "}"].join("\n"));
		const message = messageOf(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "function b() {", newText: "function c() {" }], "f.ts"),
		);
		expect(message).toContain("line 1: function a() {");
		expect(message).not.toContain("line 2: }");
	});

	it("says nothing extra when no line shares a token", () => {
		const content = normalizeToLF("alpha\nbeta\n");
		const message = messageOf(() =>
			applyEditsToNormalizedContent(content, [{ oldText: "zzz", newText: "yyy" }], "f.ts"),
		);
		expect(message).toContain("Could not find the exact text");
		expect(message).not.toContain("closest");
	});

	it("keeps the edit index for a multi-edit call", () => {
		const content = normalizeToLF("first();\n");
		const message = messageOf(() =>
			applyEditsToNormalizedContent(
				content,
				[
					{ oldText: "first();", newText: "second();" },
					{ oldText: "missing();", newText: "x();" },
				],
				"f.ts",
			),
		);
		expect(message).toContain("Could not find edits[1]");
	});
});

describe("stale read hint", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	async function setup(content: string): Promise<{ dir: string; file: string }> {
		const dir = await mkdtemp(join(tmpdir(), "nanopi-edit-signals-"));
		tempDirs.push(dir);
		const file = join(dir, "sample.ts");
		await writeFile(file, content);
		clearReadSnapshot(file);
		return { dir, file };
	}

	it("is absent when the file is untouched since the read", async () => {
		const { dir } = await setup("const a = 1;\n");
		await createReadToolDefinition(dir).execute("call-1", { path: "sample.ts" }, undefined, undefined, noContext);
		const result = await createEditToolDefinition(dir).execute(
			"call-2",
			{ path: "sample.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
			undefined,
			undefined,
			noContext,
		);
		expect(result.details?.staleRead).toBeUndefined();
		expect(result.content[0]).toMatchObject({ text: "Successfully replaced 1 block(s) in sample.ts." });
	});

	it("appears when the file changed on disk after the read", async () => {
		const { dir, file } = await setup("const a = 1;\n");
		await createReadToolDefinition(dir).execute("call-1", { path: "sample.ts" }, undefined, undefined, noContext);

		// Simulate another writer: different size and mtime, same matched line.
		await writeFile(file, "const a = 1;\nconst added = true;\n");
		const future = new Date(Date.now() + 5_000);
		await utimes(file, future, future);

		const result = await createEditToolDefinition(dir).execute(
			"call-2",
			{ path: "sample.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
			undefined,
			undefined,
			noContext,
		);
		const text = (result.content[0] as { text: string }).text;
		expect(result.details?.staleRead).toBeDefined();
		expect(text).toContain("changed on disk after you read it");
		// Advisory, not a failure: the edit still happened.
		expect(text).toContain("Successfully replaced 1 block(s)");
	});

	it("does not warn when the file was never read", async () => {
		const { dir } = await setup("const a = 1;\n");
		const result = await createEditToolDefinition(dir).execute(
			"call-1",
			{ path: "sample.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
			undefined,
			undefined,
			noContext,
		);
		expect(result.details?.staleRead).toBeUndefined();
	});

	it("refreshes the snapshot after a successful edit", async () => {
		const { dir, file } = await setup("const a = 1;\n");
		await createReadToolDefinition(dir).execute("call-1", { path: "sample.ts" }, undefined, undefined, noContext);

		await createEditToolDefinition(dir).execute(
			"call-2",
			{ path: "sample.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] },
			undefined,
			undefined,
			noContext,
		);
		const after = await stat(file);

		// The edit itself changed size and mtime; a follow-up edit must not treat
		// its own write as someone else's change.
		const second = await createEditToolDefinition(dir).execute(
			"call-3",
			{ path: "sample.ts", edits: [{ oldText: "const a = 2;", newText: "const a = 3;" }] },
			undefined,
			undefined,
			noContext,
		);
		expect(second.details?.staleRead).toBeUndefined();
		expect((await stat(file)).mtimeMs).toBeGreaterThanOrEqual(after.mtimeMs);
	});
});
