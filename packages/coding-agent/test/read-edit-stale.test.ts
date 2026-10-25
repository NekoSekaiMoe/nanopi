import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleToolContext } from "../src/core/modules/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { clearReadSnapshot } from "../src/core/tools/read-snapshot.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "nanopi-read-stale-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function toolContext(cwd: string): ModuleToolContext {
	return { cwd } as ModuleToolContext;
}

async function readText(cwd: string, path: string): Promise<string> {
	const read = createReadToolDefinition(cwd);
	const result = await read.execute("call", { path }, undefined, undefined, toolContext(cwd));
	return result.content.find((block) => block.type === "text")?.text ?? "";
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

describe("read -> edit stale detection", () => {
	it("stays quiet when the file did not change", async () => {
		const dir = await createTempDir();
		const file = join(dir, "a.txt");
		const absolute = join(dir, "a.txt");
		clearReadSnapshot(absolute);
		await writeFile(file, "before\n");
		await readText(dir, "a.txt");
		const message = await editText(dir, "a.txt", "before", "after");
		expect(message).toContain("Successfully replaced");
		expect(message).not.toContain("changed on disk");
	});

	it("notes a change that happened after the read but still applies the edit", async () => {
		const dir = await createTempDir();
		const file = join(dir, "b.txt");
		const absolute = join(dir, "b.txt");
		clearReadSnapshot(absolute);
		await writeFile(file, "before\ntail\n");
		await readText(dir, "b.txt");
		// Simulate an external edit that keeps the matched text intact.
		const future = new Date(Date.now() + 60_000);
		await writeFile(file, "before\ntail\nappended\n");
		await utimes(file, future, future);

		const message = await editText(dir, "b.txt", "before", "after");
		expect(message).toContain("Successfully replaced");
		expect(message).toContain("changed on disk after you read it");
		expect(await readFile(file, "utf-8")).toBe("after\ntail\nappended\n");
	});

	it("does not warn when no read preceded the edit", async () => {
		const dir = await createTempDir();
		const file = join(dir, "c.txt");
		clearReadSnapshot(join(dir, "c.txt"));
		await writeFile(file, "before\n");
		const message = await editText(dir, "c.txt", "before", "after");
		expect(message).not.toContain("changed on disk");
	});

	it("treats the edit's own result as what the model saw next", async () => {
		const dir = await createTempDir();
		const file = join(dir, "d.txt");
		clearReadSnapshot(join(dir, "d.txt"));
		await writeFile(file, "one\n");
		await editText(dir, "d.txt", "one", "two");
		const message = await editText(dir, "d.txt", "two", "three");
		expect(message).toContain("Successfully replaced");
		expect(message).not.toContain("changed on disk");
	});
});
