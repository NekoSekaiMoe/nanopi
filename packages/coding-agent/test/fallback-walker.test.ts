import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { walkFiles } from "../src/core/tools/fallback-walker.ts";

describe("fallback walker", () => {
	let root: string;
	const visited: string[] = [];
	const record = async (filePath: string) => {
		visited.push(
			filePath
				.slice(root.length + 1)
				.split("\\")
				.join("/"),
		);
		return true;
	};

	beforeEach(() => {
		root = join(tmpdir(), `fallback-walker-test-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		visited.length = 0;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("applies nested .gitignore rules relative to their own directory", async () => {
		writeFileSync(join(root, ".gitignore"), "*.log\n");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", ".gitignore"), "generated/\n");
		mkdirSync(join(root, "src", "generated"));
		writeFileSync(join(root, "src", "generated", "out.ts"), "");
		writeFileSync(join(root, "src", "a.ts"), "");
		writeFileSync(join(root, "debug.log"), "");

		await walkFiles(root, { visit: record });

		expect(visited).toContain("src/a.ts");
		expect(visited).toContain(".gitignore");
		expect(visited).not.toContain("debug.log");
		expect(visited).not.toContain("src/generated/out.ts");
	});

	it("honors negated rules that re-include a file", async () => {
		// `build/` would exclude the directory outright, and git gives no way back
		// from that; `build/*` excludes the contents, which a negation can undo.
		writeFileSync(join(root, ".gitignore"), "build/*\n!build/keep.ts\n");
		mkdirSync(join(root, "build"));
		writeFileSync(join(root, "build", "keep.ts"), "");
		writeFileSync(join(root, "build", "drop.ts"), "");

		await walkFiles(root, { visit: record });

		expect(visited).toContain("build/keep.ts");
		expect(visited).not.toContain("build/drop.ts");
	});

	it("does not follow symlinked directories", async () => {
		mkdirSync(join(root, "real"));
		writeFileSync(join(root, "real", "inside.ts"), "");
		symlinkSync(join(root, "real"), join(root, "linked"));

		await walkFiles(root, { visit: record });

		expect(visited).toContain("real/inside.ts");
		expect(visited.filter((entry) => entry.startsWith("linked/"))).toEqual([]);
	});

	it("stops when the visitor returns false", async () => {
		for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(root, name), "");

		let count = 0;
		const finished = await walkFiles(root, {
			visit: () => {
				count += 1;
				return false;
			},
		});

		expect(finished).toBe(false);
		expect(count).toBe(1);
	});
});
