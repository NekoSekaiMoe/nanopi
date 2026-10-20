import { describe, expect, it } from "vitest";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";

describe("createAllToolDefinitions", () => {
	it("builds every definition when no names are given", () => {
		expect(Object.keys(createAllToolDefinitions(process.cwd()))).toEqual([
			"read",
			"bash",
			"powershell",
			"edit",
			"write",
			"grep",
			"find",
			"ls",
		]);
	});

	it("builds only the named definitions", () => {
		expect(Object.keys(createAllToolDefinitions(process.cwd(), undefined, ["bash", "powershell"]))).toEqual([
			"bash",
			"powershell",
		]);
	});

	it("skips names the build does not know", () => {
		expect(Object.keys(createAllToolDefinitions(process.cwd(), undefined, ["grep", "nope"]))).toEqual(["grep"]);
	});
});
