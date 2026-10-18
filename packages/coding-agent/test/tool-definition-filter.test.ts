import { describe, expect, it } from "vitest";
import { filterToolDefinitions } from "../src/core/tools/index.ts";

const definitions = { read: {}, bash: {}, powershell: {}, edit: {}, write: {} };

describe("filterToolDefinitions", () => {
	it("keeps every definition when no names are given", () => {
		expect(filterToolDefinitions(definitions, undefined)).toBe(definitions);
	});

	it("keeps only the named definitions, dropping the rest", () => {
		expect(Object.keys(filterToolDefinitions(definitions, ["bash", "powershell"]))).toEqual(["bash", "powershell"]);
	});

	it("yields nothing for names the build does not register", () => {
		expect(Object.keys(filterToolDefinitions(definitions, ["grep"]))).toEqual([]);
	});
});
