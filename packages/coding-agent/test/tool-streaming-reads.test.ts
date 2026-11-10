import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepToolDefinition, type GrepOperations } from "../src/core/tools/grep.ts";
import { readLinePage } from "../src/core/tools/line-reader.ts";
import { createReadToolDefinition, type ReadOperations } from "../src/core/tools/read.ts";

let testDir: string;

beforeEach(() => {
	testDir = join(tmpdir(), `coding-agent-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

/** Operations that fail the test if a file is ever read into memory. */
function readFileMustNotBeCalled(): ReadOperations {
	return {
		readFile: () => {
			throw new Error("readFile() must not be called for a text file: the reader streams");
		},
		access: async () => {},
		detectImageMimeType: async () => undefined,
	};
}

describe("streaming tool reads", () => {
	describe("read tool", () => {
		it("shows a page of a large file without reading the whole file", async () => {
			// A file far larger than any byte limit: if the tool loaded it as one string, this
			// test would either OOM or trip the readFile() guard below.
			const testFile = join(testDir, "huge.log");
			const rows = Array.from({ length: 200_000 }, (_, i) => `line ${i + 1} ${"x".repeat(80)}`);
			writeFileSync(testFile, rows.join("\n"));

			const tool = createReadToolDefinition(testDir, { operations: readFileMustNotBeCalled() });
			const result = await tool.execute(
				"read-page",
				{ path: "huge.log", offset: 199_990, limit: 5 },
				undefined,
				undefined,
				{ cwd: testDir } as any,
			);
			const output = getTextOutput(result);

			expect(output).toContain("line 199990 ");
			expect(output).toContain("line 199994 ");
			expect(output).toContain("[6 more lines in file. Use offset=199995 to continue.]");
			expect(output).not.toContain("line 199989 ");
		});

		it("keeps the byte limit and its continuation hint on a file with fewer lines", async () => {
			const testFile = join(testDir, "wide.txt");
			const rows = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
			writeFileSync(testFile, rows.join("\n"));

			const tool = createReadToolDefinition(testDir, { operations: readFileMustNotBeCalled() });
			const result = await tool.execute("read-bytes", { path: "wide.txt" }, undefined, undefined, {
				cwd: testDir,
			} as any);
			const output = getTextOutput(result);

			expect(output).toMatch(/\[Showing lines 1-\d+ of 500 \(.* limit\)\. Use offset=\d+ to continue\.\]/);
		});

		it("keeps the file's own trailing newline", async () => {
			// Blanking the trailing newline showed the model text the file does not contain:
			// the whole-file read returned it, and the task suite asserts on it.
			const testFile = join(testDir, "trailing.txt");
			writeFileSync(testFile, "one\ntwo\nthree\n");

			const tool = createReadToolDefinition(testDir, { operations: readFileMustNotBeCalled() });
			const result = await tool.execute("read-trailing", { path: "trailing.txt" }, undefined, undefined, {
				cwd: testDir,
			} as any);

			expect(getTextOutput(result)).toBe("one\ntwo\nthree\n");
		});

		it("counts an offset past the end against the real line count", async () => {
			const testFile = join(testDir, "short.txt");
			writeFileSync(testFile, "a\nb\nc");

			const tool = createReadToolDefinition(testDir, { operations: readFileMustNotBeCalled() });
			await expect(
				tool.execute("read-oob", { path: "short.txt", offset: 100 }, undefined, undefined, {
					cwd: testDir,
				} as any),
			).rejects.toThrow(/Offset 100 is beyond end of file \(3 lines total\)/);
		});
	});

	describe("grep context", () => {
		it("never reads a matched file, even with context", async () => {
			writeFileSync(join(testDir, "a.txt"), "before\nmatch here\nafter\n");

			const operations: GrepOperations = {
				isDirectory: () => false,
				readFile: () => {
					throw new Error("readFile() must not be called: ripgrep reports context itself");
				},
			};
			const tool = createGrepToolDefinition(testDir, { operations });
			const result = await tool.execute(
				"grep-context",
				{ pattern: "match", path: join(testDir, "a.txt"), context: 1 },
				undefined,
				undefined,
				{ cwd: testDir } as any,
			);
			const output = getTextOutput(result);

			expect(output).toContain("a.txt-1- before");
			expect(output).toContain("a.txt:2: match here");
			expect(output).toContain("a.txt-3- after");
		});

		it("keeps UTF-16 lines intact with context", async () => {
			// Decoded as UTF-8 a UTF-16LE file has no visible line breaks, so a hand-rolled
			// split() saw one giant line and printed no context at all.
			const testFile = join(testDir, "utf16.txt");
			writeFileSync(testFile, Buffer.from("\uFEFFbefore\nmatch here\nafter\n", "utf16le"));

			const tool = createGrepToolDefinition(testDir);
			const result = await tool.execute(
				"grep-utf16",
				{ pattern: "match", path: testFile, context: 1 },
				undefined,
				undefined,
				{ cwd: testDir } as any,
			);
			const output = getTextOutput(result);

			expect(output).toContain("utf16.txt:2: match here");
			expect(output).toContain("utf16.txt-3- after");
		});
	});

	describe("readLinePage", () => {
		it("strips a UTF-16 BOM and its CRLF line endings", async () => {
			const testFile = join(testDir, "crlf16.txt");
			writeFileSync(testFile, Buffer.from("\uFEFFone\r\ntwo\r\nthree", "utf16le"));

			const page = await readLinePage(testFile, { startLine: 0 });

			expect(page.encoding).toBe("utf16le");
			expect(page.content).toBe("one\ntwo\nthree");
			expect(page.totalLines).toBe(3);
		});

		it("reports every line after the page in totalLines", async () => {
			const testFile = join(testDir, "count.txt");
			writeFileSync(testFile, "1\n2\n3\n4\n5");

			const page = await readLinePage(testFile, { startLine: 2, lineLimit: 2 });

			expect(page.content).toBe("3\n4");
			expect(page.totalLines).toBe(5);
		});
	});
});
