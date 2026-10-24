import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getAgentDir, resolveHostEntry } from "../src/config.ts";
import { createModuleRuntime, ModuleRegistry } from "../src/core/modules/registry.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-host-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

describe("ctx.resolveHostEntry", () => {
	test("answers the package bin, not a path guessed from the caller's location", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "dist", "bundle"), { recursive: true });
		const entry = join(dir, "dist", "bundle", "cli.js");
		writeFileSync(entry, "");
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", bin: { nanopi: "dist/bundle/cli.js" } }));
		const previous = process.env.NANOPI_PACKAGE_DIR;
		process.env.NANOPI_PACKAGE_DIR = dir;
		try {
			const resolved = resolveHostEntry();
			// A module spawning a child has to run this installation's entry, and
			// only the package that owns it can say which file that is.
			expect(resolved.args).toEqual([entry]);
			expect(resolved.cmd).toBe(process.execPath);
		} finally {
			if (previous === undefined) delete process.env.NANOPI_PACKAGE_DIR;
			else process.env.NANOPI_PACKAGE_DIR = previous;
		}
	});

	test("refuses a bin entry that is not on disk instead of handing the child a broken path", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", bin: { nanopi: "dist/missing.js" } }));
		const previous = process.env.NANOPI_PACKAGE_DIR;
		process.env.NANOPI_PACKAGE_DIR = dir;
		try {
			// A missing entry only turns into MODULE_NOT_FOUND inside the child,
			// where the parent cannot attribute it.
			expect(resolveHostEntry().args).toEqual([]);
		} finally {
			if (previous === undefined) delete process.env.NANOPI_PACKAGE_DIR;
			else process.env.NANOPI_PACKAGE_DIR = previous;
		}
	});

	test("falls back to the command name when there is no package to read", () => {
		const dir = tempDir();
		chmodSync(dir, 0o500);
		const previous = process.env.NANOPI_PACKAGE_DIR;
		process.env.NANOPI_PACKAGE_DIR = dir;
		try {
			expect(resolveHostEntry()).toEqual({ cmd: "nanopi", args: [] });
		} finally {
			if (previous === undefined) delete process.env.NANOPI_PACKAGE_DIR;
			else process.env.NANOPI_PACKAGE_DIR = previous;
		}
	});
});

describe("ctx.getAgentDir", () => {
	test("is the host's own resolution, so one module cannot read a second copy of the config", () => {
		const dir = tempDir();
		const previous = process.env.NANOPI_CODING_AGENT_DIR;
		process.env.NANOPI_CODING_AGENT_DIR = dir;
		try {
			const registry = new ModuleRegistry([], createModuleRuntime(), process.cwd(), {} as never, {} as never);
			expect(registry.createContext().getAgentDir()).toBe(getAgentDir());
			expect(registry.createContext().getAgentDir()).toBe(dir);
		} finally {
			if (previous === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
			else process.env.NANOPI_CODING_AGENT_DIR = previous;
		}
	});
});
