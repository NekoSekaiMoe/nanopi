import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBudget } from "../src/extras/pi-lsp-mini/src/budget.ts";
import { DEFAULT_SETTINGS, resetServersCache } from "../src/extras/pi-lsp-mini/src/config.ts";
import { clampHover, hoverText } from "../src/extras/pi-lsp-mini/src/hover.ts";
import { LspManager } from "../src/extras/pi-lsp-mini/src/manager.ts";
import {
	findByName,
	locateInText,
	resolveTarget,
	snapToIdentifier,
} from "../src/extras/pi-lsp-mini/src/symbol-target.ts";

const FAKE_SERVER = join(
	import.meta.dirname,
	"..",
	"src",
	"extras",
	"pi-lsp-mini",
	"src",
	"__tests__",
	"fixtures",
	"fake-lsp-server.mjs",
);

const temps: string[] = [];
const managers: LspManager[] = [];
const savedEnv = { ...process.env };

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "lsp-hover-"));
	temps.push(dir);
	return dir;
}

/** A project whose only server is the fake one; `content` is the file the tests resolve symbols in. */
function project(content: string, env: Record<string, string> = {}): { cwd: string; file: string } {
	const cwd = tempDir();
	const agentDir = tempDir();
	writeFileSync(join(cwd, ".git"), "");
	const file = join(cwd, "sample.txt");
	writeFileSync(file, content);
	writeFileSync(
		join(agentDir, "lsp.json"),
		JSON.stringify({
			servers: [
				{
					id: "fake",
					command: `${process.execPath} ${FAKE_SERVER}`,
					include: [".txt"],
					rootMarkers: [".git"],
					requestTimeout: 20_000,
				},
			],
		}),
	);
	process.env.NANOPI_CODING_AGENT_DIR = agentDir;
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	resetServersCache();
	return { cwd, file };
}

function newManager(): LspManager {
	resetServersCache();
	const manager = new LspManager();
	managers.push(manager);
	return manager;
}

beforeEach(() => {
	delete process.env.FAKE_LSP_NO_SYMBOLS;
});

afterEach(async () => {
	for (const key of ["FAKE_LSP_NO_SYMBOLS", "NANOPI_CODING_AGENT_DIR"]) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	for (const manager of managers.splice(0)) await manager.shutdownAll();
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
	resetServersCache();
});

describe("position resolution", () => {
	it("snaps an off-by-one column onto the identifier", () => {
		const lines = ["const value = parse(input);"];
		expect(snapToIdentifier(lines, 1, 1)).toEqual({ line: 0, character: 0 });
		expect(snapToIdentifier(lines, 1, 15)).toEqual({ line: 0, character: 14 });
	});

	it("finds a symbol by name in the file text", () => {
		expect(locateInText(["a();", "  parse(input);"], "parse")).toEqual({ line: 1, character: 2 });
		expect(locateInText(["a();"], "parse")).toBeUndefined();
	});

	it("prefers a symbol the server reports over the text", async () => {
		const { cwd, file } = project("parse(other)\n");
		const manager = newManager();
		const opened = await manager.openFile({ cwd }, file);
		expect(opened).toBeDefined();
		const budget = createBudget({ timeoutMs: 5000, defaultTimeoutMs: DEFAULT_SETTINGS.requestTimeout });
		const resolved = await resolveTarget(opened!.client, file, { symbol: "parse" }, budget);
		expect(resolved?.cursor).toEqual({ line: 0, character: 0 });
		expect(resolved?.match?.name).toBe("parse");
	});

	it("falls back to the text when the server has no documentSymbol", async () => {
		const { cwd, file } = project("other()\n  parse(input)\n", { FAKE_LSP_NO_SYMBOLS: "1" });
		const manager = newManager();
		const opened = await manager.openFile({ cwd }, file);
		expect(opened).toBeDefined();
		const budget = createBudget({ timeoutMs: 5000, defaultTimeoutMs: DEFAULT_SETTINGS.requestTimeout });
		const resolved = await resolveTarget(opened!.client, file, { symbol: "parse" }, budget);
		expect(resolved?.cursor).toEqual({ line: 1, character: 2 });
		expect(resolved?.match).toBeUndefined();
	});

	it("answers nothing for a symbol that is not in the file", async () => {
		const { cwd, file } = project("parse(other)\n");
		const manager = newManager();
		const opened = await manager.openFile({ cwd }, file);
		expect(opened).toBeDefined();
		expect(await resolveTarget(opened!.client, file, { symbol: "missing" }, undefined)).toBeUndefined();
	});

	it("matches a nested symbol by its last name segment", () => {
		const range = { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } };
		const symbols = [
			{
				name: "Config",
				kind: 5,
				range,
				selectionRange: range,
				children: [
					{
						name: "parse",
						kind: 6,
						range,
						selectionRange: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
					},
				],
			},
		];
		expect(findByName(symbols, "Config.parse")).toEqual({
			name: "parse",
			line: 2,
			character: 4,
			container: "Config",
		});
	});
});

describe("hover rendering", () => {
	it("flattens every contents shape into one string", () => {
		expect(hoverText({ contents: "plain" })).toBe("plain");
		expect(hoverText({ contents: { kind: "markdown", value: "doc" } })).toBe("doc");
		expect(hoverText({ contents: [{ language: "ts", value: "const a = 1" }, "trailing"] })).toBe(
			"```ts\nconst a = 1\n```\n\ntrailing",
		);
		expect(hoverText(null)).toBe("");
	});

	it("cuts on a line boundary so a code block is not left open", () => {
		const clamped = clampHover(`${"x".repeat(900)}\n${"y".repeat(900)}\n`);
		expect(clamped).toContain("[... ");
		expect(clamped.split("\n")[0]).toHaveLength(900);
	});
});

describe("client requests", () => {
	it("answers hover and definition for the resolved cursor", async () => {
		const { cwd, file } = project("other()\n  parse(input)\n");
		const manager = newManager();
		const opened = await manager.openFile({ cwd }, file);
		expect(opened).toBeDefined();
		const budget = createBudget({ timeoutMs: 5000, defaultTimeoutMs: DEFAULT_SETTINGS.requestTimeout });
		const resolved = await resolveTarget(opened!.client, file, { symbol: "parse" }, budget);
		expect(resolved).toBeDefined();

		const hover = await opened!.client.hover(file, resolved!.cursor.line, resolved!.cursor.character, budget);
		expect(hoverText(hover)).toBe("hover: parse");

		const definition = await opened!.client.definition(
			file,
			resolved!.cursor.line,
			resolved!.cursor.character,
			budget,
		);
		expect(Array.isArray(definition) ? definition[0].range.start.line : -1).toBe(0);
	});

	it("reports a deadline that expired instead of hanging", async () => {
		const { cwd, file } = project("parse(input)\n", { FAKE_LSP_SLOW_MS: "1500" });
		const manager = newManager();
		const opened = await manager.openFile({ cwd }, file);
		expect(opened).toBeDefined();
		const answer = await opened!.client
			.hover(file, 0, 0, createBudget({ timeoutMs: 300, defaultTimeoutMs: 20_000 }))
			.then(
				() => "resolved",
				(error: Error) => error.message,
			);
		expect(answer).toMatch(/timed out after 300ms/);
	});
});
