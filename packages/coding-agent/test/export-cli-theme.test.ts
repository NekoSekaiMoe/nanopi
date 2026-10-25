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

// `--export` used to write HTML whatever the output path said. The format now
// comes from the extension, with `--export-format` to override it.
describe("CLI --export formats", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function writeSession(dir: string): string {
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
		return sessionFile;
	}

	async function runExport(args: string[]): Promise<void> {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const originalExit = process.exit;
		process.exit = ((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit;
		try {
			await expect(main(args)).rejects.toThrow("exit 0");
			expect(error).not.toHaveBeenCalled();
		} finally {
			process.exit = originalExit;
			log.mockRestore();
			error.mockRestore();
		}
	}

	test("writes Markdown when the output path ends in .md", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nanopi-export-md-"));
		tempDirs.push(dir);
		const outputPath = join(dir, "out.md");
		await runExport(["--export", writeSession(dir), outputPath]);
		const markdown = readFileSync(outputPath, "utf8");
		expect(markdown).toContain("## User");
		expect(markdown).toContain("hi there");
	});

	test("refuses .pdf with the print-the-HTML hint instead of writing a file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nanopi-export-pdf-"));
		tempDirs.push(dir);
		const outputPath = join(dir, "out.pdf");
		const sessionFile = writeSession(dir);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const originalExit = process.exit;
		process.exit = ((code?: number) => {
			throw new Error(`exit ${code}`);
		}) as typeof process.exit;
		try {
			await expect(main(["--export", sessionFile, outputPath])).rejects.toThrow("exit 1");
		} finally {
			process.exit = originalExit;
		}
		expect(String(error.mock.calls[0]?.[0])).toContain("print that document to PDF from a browser");
		error.mockRestore();
		expect(existsSync(outputPath)).toBe(false);
	});

	test("keeps HTML for a path without a known export extension", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nanopi-export-html-"));
		tempDirs.push(dir);
		const outputPath = join(dir, "out.txt");
		await runExport(["--export", writeSession(dir), outputPath]);
		expect(readFileSync(outputPath, "utf8")).toContain('id="session-data"');
	});

	test("lets --export-format override the extension", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nanopi-export-format-"));
		tempDirs.push(dir);
		const outputPath = join(dir, "out.txt");
		await runExport(["--export", writeSession(dir), "--export-format", "md", outputPath]);
		expect(readFileSync(outputPath, "utf8")).toContain("## User");
	});
});
