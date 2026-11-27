/** Regression for issue #852: git and web actions live behind two tool names. */
import { describe, expect, test, vi } from "vitest";
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

function ctx(): any {
	return { cwd: process.cwd(), getAgentDir: () => process.cwd() };
}

describe("tool merge (issue #852)", () => {
	test("registers one git tool and one web tool", () => {
		const first = surface();
		gitTools(first.pi as never);
		websearch(first.pi as never);
		expect([...first.tools.keys()]).toEqual(["git", "web"]);
	});

	test("git actions dispatch to status and log", async () => {
		const { tools, pi } = surface();
		gitTools(pi as never);
		const git = tools.get("git")!;
		const status = await git.execute("call-status", {}, undefined, undefined, ctx());
		expect(status.content[0].text).toContain("git");
		const log = await git.execute("call-log", { action: "log", limit: 1 }, undefined, undefined, ctx());
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

	test("web DeepWiki actions call the same endpoint adapter", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: { content: [{ type: "text", text: "outline" }] },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			const { tools, pi } = surface();
			websearch(pi as never);
			const web = tools.get("web")!;
			const structure = await web.execute(
				"call-wiki",
				{ action: "wiki_structure", repoName: "owner/repo" },
				undefined,
				undefined,
				ctx(),
			);
			expect(structure.content[0].text).toBe("outline");
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(JSON.parse(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body as string)).toMatchObject({
				method: "tools/call",
				params: { name: "read_wiki_structure", arguments: { repoName: "owner/repo" } },
			});
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
