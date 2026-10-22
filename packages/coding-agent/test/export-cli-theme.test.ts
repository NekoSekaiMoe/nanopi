import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { main } from "../src/main.ts";

// `nanopi --export` renders the export CSS from the active theme, so main() has
// to install the theme before the export branch. It used to leave the theme
// uninstalled and every `--export` run died with "Theme not initialized".
describe("CLI --export", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test("writes an HTML file without a session mode installing the theme", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nanopi-export-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "session.jsonl");
		writeFileSync(
			sessionFile,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "11111111-2222-3333-4444-555555555555",
					timestamp: "2026-10-22T00:00:00.000Z",
					cwd: dir,
				}),
				JSON.stringify({
					type: "message",
					id: "aaaabbbb",
					parentId: null,
					timestamp: "2026-10-22T00:00:01.000Z",
					message: { role: "user", content: [{ type: "text", text: "hi there" }] },
				}),
			].join("\n")}\n`,
			"utf8",
		);
		const outputPath = join(dir, "out.html");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const originalExit = process.exit;
		// The export branch ends with process.exit(0); the run is over by then, so
		// the test only needs the throw to stop main() from continuing into a mode.
		process.exit = ((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit;
		try {
			await expect(main(["--export", sessionFile, outputPath])).rejects.toThrow("exit 0");
			expect(error).not.toHaveBeenCalled();
		} finally {
			process.exit = originalExit;
			log.mockRestore();
			error.mockRestore();
		}
		expect(existsSync(outputPath)).toBe(true);
		expect(readFileSync(outputPath, "utf8")).toContain('id="session-data"');
	});
});
