import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleToolContext } from "../src/core/modules/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "nanopi-edit-non-utf8-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function toolContext(cwd: string): ModuleToolContext {
	return { cwd } as ModuleToolContext;
}

async function editText(cwd: string, path: string, oldText: string, newText: string): Promise<string> {
	const edit = createEditToolDefinition(cwd);
	const result = await edit.execute(
		"call",
		{ path, edits: [{ oldText, newText }] },
		undefined,
		undefined,
		toolContext(cwd),
	);
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

describe("edit tool and non-UTF-8 files", () => {
	// Upstream #10349: the tool decoded as UTF-8 and wrote back as UTF-8, so every undecodable
	// byte became U+FFFD while the call reported success.
	it("refuses a UTF-16 file and leaves it byte-identical", async () => {
		const dir = await createTempDir();
		const path = join(dir, "utf16.txt");
		const original = Buffer.from("héllo wörld\n", "utf16le");
		await writeFile(path, original);

		await expect(editText(dir, "utf16.txt", "wörld", "there")).rejects.toThrow(/not valid UTF-8/);
		expect((await readFile(path)).equals(original)).toBe(true);
	});

	it("refuses a Windows-1252 file and leaves it byte-identical", async () => {
		const dir = await createTempDir();
		const path = join(dir, "legacy.txt");
		// 0xE9 is `é` in Windows-1252 and an invalid UTF-8 continuation byte on its own.
		const original = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
		await writeFile(path, original);

		await expect(editText(dir, "legacy.txt", "cafe", "tea")).rejects.toThrow(/not valid UTF-8/);
		expect((await readFile(path)).equals(original)).toBe(true);
	});

	it("still edits valid UTF-8 with a byte order mark", async () => {
		const dir = await createTempDir();
		const path = join(dir, "bom.txt");
		await writeFile(path, "\uFEFFalpha\n", "utf-8");

		const message = await editText(dir, "bom.txt", "alpha", "beta");

		expect(message).toContain("Successfully replaced");
		expect(await readFile(path, "utf-8")).toBe("\uFEFFbeta\n");
	});
});
