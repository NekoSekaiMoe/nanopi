import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchSpec, resolveCommand } from "../executables.ts";

const temps: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "mcp-exec-"));
	temps.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mcp command resolution", () => {
	it("resolves a command on PATH to its absolute path", () => {
		const dir = tempDir();
		const file = join(dir, "server-bin");
		writeFileSync(file, "#!/bin/sh\n");
		chmodSync(file, 0o755);
		const previous = process.env.PATH;
		process.env.PATH = [dir, previous].join(delimiter);
		try {
			expect(resolveCommand("server-bin")).toBe(file);
			expect(launchSpec("server-bin", ["--x"])).toEqual({ command: file, args: ["--x"] });
		} finally {
			process.env.PATH = previous;
		}
	});

	it("leaves a missing command alone so the spawn error still says what was asked for", () => {
		const previous = process.env.PATH;
		process.env.PATH = tempDir();
		try {
			expect(resolveCommand("no-such-server")).toBeUndefined();
			expect(launchSpec("no-such-server", [])).toEqual({ command: "no-such-server", args: [] });
		} finally {
			process.env.PATH = previous;
		}
	});

	it("keeps explicit relative paths untouched", () => {
		expect(launchSpec("./bin/server", ["a"]).command).toBe("./bin/server");
	});
});
