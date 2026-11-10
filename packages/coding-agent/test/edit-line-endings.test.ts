import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleToolContext } from "../src/core/modules/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import {
	applyEditsToNormalizedContent,
	applyReplacementsToOriginal,
	normalizeToLF,
} from "../src/core/tools/edit-diff.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "nanopi-edit-endings-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function editFile(original: string, oldText: string, newText: string): Promise<string> {
	const dir = await createTempDir();
	const path = join(dir, "file.txt");
	await writeFile(path, original);
	const edit = createEditToolDefinition(dir);
	await edit.execute("call", { path: "file.txt", edits: [{ oldText, newText }] }, undefined, undefined, {
		cwd: dir,
	} as ModuleToolContext);
	return await readFile(path, "utf8");
}

describe("edit tool line ending fidelity", () => {
	// Upstream #8544: the file was rewritten to the first line ending seen, so a mixed file
	// came back with every line forced to one style.
	it("keeps CRLF lines around an LF edit", async () => {
		const original = "a\nb\r\nX = 1\r\n";
		expect(await editFile(original, "X = 1", "X = 2")).toBe("a\nb\r\nX = 2\r\n");
	});

	it("keeps LF lines around a CRLF edit", async () => {
		const original = "a\r\nb\nc\n";
		expect(await editFile(original, "b", "B")).toBe("a\r\nB\nc\n");
	});

	it("keeps a lone CR as a lone CR", async () => {
		const original = "a\rb\nc\n";
		expect(await editFile(original, "b", "B")).toBe("a\rB\nc\n");
	});

	it("leaves every byte outside the edited range untouched", async () => {
		const original = "l1\r\nl2\nl3\rl4\r\nTARGET\r\nl6\n";
		const updated = await editFile(original, "TARGET", "REPLACED");
		expect(updated).toBe("l1\r\nl2\nl3\rl4\r\nREPLACED\r\nl6\n");
	});

	it("gives a line the replacement added the terminator of the line it replaced", async () => {
		const original = "a\r\nb\r\nc\r\n";
		expect(await editFile(original, "b", "b1\nb2")).toBe("a\r\nb1\r\nb2\r\nc\r\n");
	});

	it("keeps CRLF when several edits land on different lines", async () => {
		const original = "one\r\ntwo\r\nthree\r\n";
		const dir = await createTempDir();
		const path = join(dir, "file.txt");
		await writeFile(path, original);
		const edit = createEditToolDefinition(dir);
		await edit.execute(
			"call",
			{
				path: "file.txt",
				edits: [
					{ oldText: "one", newText: "ONE" },
					{ oldText: "three", newText: "THREE" },
				],
			},
			undefined,
			undefined,
			{ cwd: dir } as ModuleToolContext,
		);
		expect(await readFile(path, "utf8")).toBe("ONE\r\ntwo\r\nTHREE\r\n");
	});

	it("treats a replacement starting with LF as ending the line it replaces", async () => {
		// The line before ends with a lone CR, which stays. The replacement's leading LF ends the
		// replacement's first line, so the text after it is a new line and takes the original's.
		const original = "a\rb\n";
		expect(await editFile(original, "b", "\nc")).toBe("a\r\nc\n");
	});
});

describe("applyReplacementsToOriginal", () => {
	it("keeps untouched bytes for every random mixed-ending file", () => {
		// 3000 random files: the mapping runs off normalized offsets, and a file whose endings vary
		// line by line is where an off-by-one shows up.
		let seed = 0x2f6e2b1;
		const random = (): number => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};

		for (let round = 0; round < 3000; round++) {
			const lineCount = 1 + Math.floor(random() * 6);
			const endings = ["\n", "\r\n", "\r"];
			let original = "";
			for (let line = 0; line < lineCount; line++) {
				original += `line${line}`;
				original += endings[Math.floor(random() * endings.length)];
			}

			const normalizedContent = normalizeToLF(original);
			const { replacements } = applyEditsToNormalizedContent(
				normalizedContent,
				[{ oldText: "line0", newText: "LINE0" }],
				"file.txt",
			);
			const rebuilt = applyReplacementsToOriginal(original, normalizedContent, replacements);

			// The edit only rewrote its own range: `line0` became `LINE0` and every byte after it is
			// the original byte, in order. That is the whole property, terminators included.
			expect(rebuilt).toBe(`LINE0${original.slice("line0".length)}`);
		}
	});
});
