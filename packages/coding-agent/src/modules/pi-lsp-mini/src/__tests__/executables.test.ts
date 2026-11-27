import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { firstWord, isExecutableAvailable, resolveExecutable } from "../executables.ts";

const temps: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lsp-exec-"));
	temps.push(dir);
	return dir;
}

function fakeBinary(dir: string, name: string): string {
	const file = join(dir, name);
	writeFileSync(file, "#!/bin/sh\nexit 0\n");
	chmodSync(file, 0o755);
	return file;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("executable resolution", () => {
	it("finds an executable on PATH", () => {
		const dir = tempDir();
		const file = fakeBinary(dir, "gopls");
		const previous = process.env.PATH;
		process.env.PATH = [dir, previous].join(delimiter);
		try {
			expect(isExecutableAvailable("gopls")).toBe(true);
			expect(resolveExecutable("gopls")).toBe(file);
		} finally {
			process.env.PATH = previous;
		}
	});

	it("misses a name that is not there", () => {
		const dir = tempDir();
		const previous = process.env.PATH;
		process.env.PATH = dir;
		try {
			expect(resolveExecutable("definitely-not-a-language-server")).toBeUndefined();
		} finally {
			process.env.PATH = previous;
		}
	});

	it("answers absolute paths from the filesystem", () => {
		const dir = tempDir();
		const file = fakeBinary(dir, "clangd");
		expect(resolveExecutable(file)).toBe(file);
		expect(resolveExecutable(join(dir, "missing-clangd"))).toBeUndefined();
	});

	it("keeps only the executable word of an inline command", () => {
		expect(firstWord("typescript-language-server --stdio")).toBe("typescript-language-server");
		expect(firstWord("  gopls  ")).toBe("gopls");
	});

	it("honours PATHEXT on Windows-shaped lookups", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "npx.cmd"), "@echo off\r\n");
		const previousPath = process.env.PATH;
		const previousExt = process.env.PATHEXT;
		process.env.PATH = dir;
		process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
		try {
			// POSIX ignores PATHEXT by design; the extension-less probe must not match.
			expect(resolveExecutable("npx")).toBeUndefined();
			expect(resolveExecutable(join(dir, "npx.cmd"))).toBe(join(dir, "npx.cmd"));
		} finally {
			process.env.PATH = previousPath;
			if (previousExt === undefined) delete process.env.PATHEXT;
			else process.env.PATHEXT = previousExt;
		}
	});
});
