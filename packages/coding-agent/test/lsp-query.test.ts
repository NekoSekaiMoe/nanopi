import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetServersCache } from "../src/extras/pi-lsp-mini/src/config.ts";
import { LspManager } from "../src/extras/pi-lsp-mini/src/manager.ts";
import { DEFINITION, DIAGNOSTICS, EDIT, HOVER, LSP_GUIDANCE, QUERY } from "../src/extras/pi-lsp-mini/src/schemas.ts";
import { lspTools, project, run } from "./helpers/pi-lsp-tools.ts";

const savedEnv = { ...process.env };
const temps: string[] = [];
const managers: LspManager[] = [];

function setup(content: string, env: Record<string, string> = {}) {
	const created = project(content, env);
	temps.push(created.cwd, process.env.NANOPI_CODING_AGENT_DIR!);
	resetServersCache();
	managers.push(new LspManager());
	return created;
}

beforeEach(() => {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("FAKE_LSP_")) delete process.env[key];
	}
});

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.shutdownAll();
	resetServersCache();
	for (const key of [
		"NANOPI_CODING_AGENT_DIR",
		...Object.keys(process.env).filter((k) => k.startsWith("FAKE_LSP_")),
	]) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The five-tool surface this replaced is gone; a model that still names the old
// tools has to be told what to call instead of getting an unknown-tool error.
it("registers one query tool instead of references and callgraph", () => {
	const tools = lspTools();
	expect(tools.has("lsp_query")).toBe(true);
	expect(tools.has("lsp_references")).toBe(false);
	expect(tools.has("lsp_callgraph")).toBe(false);
	expect(tools.size).toBe(5);
});

it("lists uses of the symbol under the cursor with the source line", async () => {
	const { cwd, file } = setup("parse(a)\nother()\n  parse(b)\n");
	const text = await run(lspTools(), "lsp_query", cwd, { path: file, line: 1, character: 1 });
	expect(text).toContain("symbol used in 2 place(s)");
	expect(text).toContain("1: parse(a)");
	expect(text).toContain("3: parse(b)");
});

it("walks the call graph when kind is callgraph", async () => {
	const { cwd, file } = setup("root()\n", { FAKE_LSP_FANOUT: "2" });
	const text = await run(lspTools(), "lsp_query", cwd, { path: file, line: 1, character: 1, kind: "callgraph" });
	expect(text).toContain("root");
	expect(text).toContain("child0");
	expect(text).toContain("child1");
});

it("answers with references when the server has no call hierarchy", async () => {
	const { cwd, file } = setup("parse(a)\n  parse(b)\n", { FAKE_LSP_NO_CALL_HIERARCHY: "1" });
	const text = await run(lspTools(), "lsp_query", cwd, { path: file, line: 1, character: 1, kind: "callgraph" });
	expect(text).toContain("symbol used in 2 place(s)");
});

it("defaults kind to references", async () => {
	const { cwd, file } = setup("parse(a)\n");
	const text = await run(lspTools(), "lsp_query", cwd, { path: file, line: 1, character: 1 });
	expect(text).toContain("symbol used in 1 place(s)");
});

// The descriptions argue how to call the tool; the snippets say when. Both
// saying "not a grep" was the same statement twice, and the schema is paid for
// on every request.
it("keeps the no-read/no-grep argument in the snippet only", () => {
	const texts = [QUERY.description, QUERY.promptSnippet].join("\n");
	expect(QUERY.description).not.toMatch(/without (reading|grepping)/i);
	expect(QUERY.promptSnippet).not.toMatch(/without (reading|grepping)/i);
	expect(texts).not.toContain("callers and callees");
});

// `read` is the tool the model actually reached for, not `grep`: it opened a
// whole file to answer what a signature was. Guidance that only competes with
// grep loses to the "use read to examine files" rule before the choice is made.
it("tells the model to prefer lsp_ over opening the file, not just over grep", () => {
	expect(LSP_GUIDANCE).toMatch(/before opening a file/i);
	expect(LSP_GUIDANCE).toMatch(/hover/i);
	expect(LSP_GUIDANCE).toMatch(/definition/i);
});

// The shared paragraph is one sentence for the whole group: <rules> dedups it,
// but the declarations are read one by one too, so only the first tool carries
// it and every tool keeps at most one copy of anything.
it("carries the shared guidance once for the group, without duplicates", () => {
	const tools: Array<{ promptGuidelines?: readonly string[] }> = [DIAGNOSTICS, HOVER, DEFINITION, QUERY, EDIT];
	const carriers = tools.filter((tool) => [...(tool.promptGuidelines ?? [])].includes(LSP_GUIDANCE));
	expect(carriers).toEqual([DIAGNOSTICS]);
	for (const tool of tools) {
		const guidelines = tool.promptGuidelines ?? [];
		expect(new Set(guidelines).size).toBe(guidelines.length);
	}
	// A tool with no rule of its own is one whose declaration already says it.
	expect(HOVER.promptGuidelines?.length ?? 0).toBeGreaterThan(0);
});
