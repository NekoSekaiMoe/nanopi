/** Regression for issue #852: git and web actions live behind two tool names. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import gitTools from "../src/modules/pi-git-tools/src/index.ts";
import websearch from "../src/modules/websearch/src/index.ts";

type Tool = {
	name: string;
	execute: (...args: any[]) => Promise<any>;
};

function surface(): { tools: Map<string, Tool>; pi: any } {
	const tools = new Map<string, Tool>();
	const pi = {
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: () => {},
	};
	return { tools, pi };
}

function ctx(cwd = process.cwd()): any {
	return { cwd, getAgentDir: () => cwd };
}

function git(cwd: string, args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

const tempRepos: string[] = [];

function createRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-tool-merge-git-"));
	tempRepos.push(dir);
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "test@example.com"]);
	git(dir, ["config", "user.name", "Test"]);
	git(dir, ["config", "commit.gpgsign", "false"]);
	writeFileSync(join(dir, "git-status-fixture.txt"), "initial\n");
	git(dir, ["add", "git-status-fixture.txt"]);
	git(dir, ["commit", "-qm", "initial commit"]);
	writeFileSync(join(dir, "git-status-fixture.txt"), "changed\n");
	return dir;
}

afterEach(() => {
	while (tempRepos.length) rmSync(tempRepos.pop()!, { recursive: true, force: true });
});

describe("tool merge (issue #852)", () => {
	test("registers one git tool and one web tool", () => {
		const first = surface();
		gitTools(first.pi as never);
		websearch(first.pi as never);
		expect([...first.tools.keys()]).toEqual(["git", "web"]);
	});

	test("git actions dispatch to status and log", async () => {
		const repo = createRepo();
		const { tools, pi } = surface();
		gitTools(pi as never);
		const gitTool = tools.get("git")!;
		const status = await gitTool.execute("call-status", {}, undefined, undefined, ctx(repo));
		expect(status.content[0].text).toContain("git-status-fixture.txt");
		const log = await gitTool.execute("call-log", { action: "log", limit: 1 }, undefined, undefined, ctx(repo));
		expect(log.content[0].text).toMatch(/[0-9a-f]{7} .+:/);
	});

	test("web action=search validates the query before touching the engine chain", async () => {
		const { tools, pi } = surface();
		websearch(pi as never);
		const web = tools.get("web")!;
		const result = await web.execute("call-search", { action: "search" }, undefined, undefined, ctx());
		expect(result.content[0].text).toContain("needs a non-empty query");
		expect(result.details.action).toBe("search");
	});

	test("web action=fetch reports an invalid URL before touching the engine chain", async () => {
		const { tools, pi } = surface();
		websearch(pi as never);
		const web = tools.get("web")!;
		const result = await web.execute(
			"call-fetch",
			{ action: "fetch", url: "not-a-url" },
			undefined,
			undefined,
			ctx(),
		);
		expect(result.content[0].text).toContain("http(s)");
		expect(result.details.action).toBe("fetch");
	});
});
