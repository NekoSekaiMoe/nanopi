import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// Ported from earendil-works/pi#11225: the exported HTML rendered a blank page for
// sessions with thousands of entries because the tree helpers recursed once per entry.
// The session tree is a chain, so its depth equals the entry count.

const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

function extractTreeSection(): string {
	const start = templateJs.indexOf("// TREE DATA PREPARATION");
	const end = templateJs.indexOf("// TREE DISPLAY TEXT");
	if (start < 0 || end < 0) throw new Error("tree section markers moved; update this test");
	return templateJs.slice(start, end);
}

function createTreeSandbox(entries: unknown[]) {
	const sandbox: Record<string, unknown> = {
		entries,
		labelMap: new Map(),
		console,
		Map,
		Set,
		Date,
		Math,
		JSON,
		Array,
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	vm.runInContext(`${extractTreeSection()}\nthis.api = { buildTree, flattenTree };`, sandbox, {
		filename: "template.js",
	});
	return sandbox as {
		api: { buildTree: () => unknown[]; flattenTree: (roots: unknown[], ids: Set<string>) => unknown[] };
	};
}

function createChainEntries(depth: number) {
	return Array.from({ length: depth }, (_, index) => ({
		id: `e${index}`,
		parentId: index === 0 ? null : `e${index - 1}`,
		timestamp: new Date(1_700_000_000_000 + index * 1000).toISOString(),
		type: "message",
		message: { role: "user", content: [{ type: "text", text: `m${index}` }] },
	}));
}

describe("export HTML tree flattening", () => {
	it("flattens a chain deep enough to overflow the previous recursion", () => {
		const depth = 8000;
		const entries = createChainEntries(depth);
		const sandbox = createTreeSandbox(entries);
		const activePathIds = new Set(entries.map((entry) => entry.id));

		const roots = sandbox.api.buildTree();
		const flat = sandbox.api.flattenTree(roots, activePathIds);

		expect(flat).toHaveLength(depth);
	});

	it("keeps branches and multi-root sessions intact", () => {
		const entries = [
			{ id: "a", parentId: null, timestamp: new Date(1000).toISOString(), type: "message" },
			{ id: "b", parentId: "a", timestamp: new Date(2000).toISOString(), type: "message" },
			{ id: "c", parentId: "a", timestamp: new Date(3000).toISOString(), type: "message" },
			{ id: "d", parentId: null, timestamp: new Date(4000).toISOString(), type: "message" },
		];
		const sandbox = createTreeSandbox(entries);

		const roots = sandbox.api.buildTree();
		const flat = sandbox.api.flattenTree(roots, new Set(["a", "c"])) as Array<{
			node: { entry: { id: string } };
		}>;

		// The branch holding the active leaf sorts first, so "d" lands after "a"/"c".
		expect(flat.map((node) => node.node.entry.id)).toEqual(["a", "c", "b", "d"]);
	});
});
