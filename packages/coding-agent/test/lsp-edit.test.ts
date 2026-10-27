import { readFileSync, rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resetServersCache } from "../src/extras/pi-lsp-mini/src/config.ts";
import { LspManager } from "../src/extras/pi-lsp-mini/src/manager.ts";
import { EDIT } from "../src/extras/pi-lsp-mini/src/schemas.ts";
import { contents, lspTools, project, run } from "./helpers/pi-lsp-tools.ts";

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

it("registers one edit tool instead of rename and delete", () => {
	const tools = lspTools();
	expect(tools.has("lsp_edit")).toBe(true);
	expect(tools.has("lsp_rename")).toBe(false);
	expect(tools.has("lsp_delete")).toBe(false);
	expect(tools.size).toBe(5);
});

// The old default was apply=true for rename and apply=false for delete. One
// tool cannot keep both, and a destructive workspace edit is the wrong place to
// guess, so an omitted `apply` previews.
it("previews a rename when apply is omitted", async () => {
	const { cwd, file } = setup("parse(a)\n");
	const text = await run(lspTools(), "lsp_edit", cwd, {
		path: file,
		line: 1,
		character: 1,
		kind: "rename",
		newName: "parseAll",
	});
	expect(text).toContain("dry-run");
	expect(text).toContain("rename to 'parseAll'");
	expect(text).toContain("re-run with apply=true");
	expect(readFileSync(file, "utf8")).toBe("parse(a)\n");
});

it("applies the rename when apply=true", async () => {
	const { cwd, file } = setup("parse(a)\n");
	const text = await run(lspTools(), "lsp_edit", cwd, {
		path: file,
		line: 1,
		character: 1,
		kind: "rename",
		newName: "parseAll",
		apply: true,
	});
	expect(text).toContain("renamed to 'parseAll'");
	expect(contents(file)).toBe("parseAll(a)\n");
});

it("previews a delete when apply is omitted", async () => {
	const { cwd, file } = setup("root()\n  parse(a)\n");
	const text = await run(lspTools(), "lsp_edit", cwd, { path: file, line: 2, character: 3, kind: "delete" });
	expect(text).toContain("dry-run");
	expect(text).toContain("delete 'parse'");
	expect(contents(file)).toBe("root()\n  parse(a)\n");
});

it("asks for newName on a rename instead of guessing", async () => {
	const { cwd, file } = setup("parse(a)\n");
	const text = await run(lspTools(), "lsp_edit", cwd, { path: file, line: 1, character: 1, kind: "rename" });
	expect(text).toBe("kind=rename needs newName");
	expect(contents(file)).toBe("parse(a)\n");
});

it("reports a server without rename support", async () => {
	const { cwd, file } = setup("parse(a)\n", { FAKE_LSP_NO_RENAME: "1" });
	const text = await run(lspTools(), "lsp_edit", cwd, {
		path: file,
		line: 1,
		character: 1,
		kind: "rename",
		newName: "x",
	});
	expect(text).toContain("does not support rename");
});

// `apply` is the whole reason this merge needed its own PR: a model that omits
// it must not be able to destroy a workspace by accident.
it("defaults apply to the preview path for both kinds", () => {
	expect(JSON.stringify(EDIT.parameters)).not.toContain('"default":true');
	expect(EDIT.description).toContain("dry-run unless apply=true");
	expect(EDIT.promptSnippet).toContain("dry-run");
});
