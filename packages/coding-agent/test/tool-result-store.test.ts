import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { getToolResultPath, isToolResultRef, readToolResult, storeToolResult } from "../src/utils/tool-result-store.ts";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "nanopi-tool-results-"));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("tool result store", () => {
	it("stores a result under a private, random ref", async () => {
		const first = await storeToolResult(agentDir, "hello", "grep");
		const second = await storeToolResult(agentDir, "hello", "grep");
		expect(first.ref).toMatch(/^grep-[0-9a-f]{16}$/);
		expect(second.ref).not.toBe(first.ref);
		expect(readFileSync(first.path, "utf8")).toBe("hello");
	});

	it("paginates stored output and preserves UTF-8 boundaries", async () => {
		const text = `${"a".repeat(20)}${"😀".repeat(20)}`;
		const stored = await storeToolResult(agentDir, text, "read");
		const first = await readToolResult(agentDir, stored.ref, 0, 21);
		const second = await readToolResult(agentDir, stored.ref, first.endByte, 200);
		expect(first.truncated).toBe(true);
		expect(first.text).toBe("a".repeat(20));
		expect(second.text).toBe("😀".repeat(20));
		expect(second.truncated).toBe(false);
	});

	it("refuses refs that could escape the store", () => {
		expect(isToolResultRef("../secret")).toBe(false);
		expect(() => getToolResultPath(agentDir, "../../etc/passwd")).toThrow(/Invalid tool result ref/);
	});
});

describe("truncated tool result notices", () => {
	it("gives read a recall ref when a page exceeds the tool budget", async () => {
		const storeDir = mkdtempSync(join(tmpdir(), "nanopi-read-result-"));
		const previousAgentDir = process.env.NANOPI_CODING_AGENT_DIR;
		process.env.NANOPI_CODING_AGENT_DIR = storeDir;
		try {
			const rows = Array.from({ length: 500 }, (_, i) => `Line ${i + 1}: ${"x".repeat(200)}`);
			const source = join(storeDir, "wide.txt");
			const { writeFileSync } = await import("node:fs");
			writeFileSync(source, rows.join("\n"));

			const tool = createReadToolDefinition(storeDir);
			const result = await tool.execute("read-wide", { path: source }, undefined, undefined, {
				cwd: storeDir,
			} as any);
			const text = result.content
				.filter((block) => block.type === "text")
				.map((block) => ("text" in block ? block.text : ""))
				.join("\n");
			expect(text).toMatch(/ref read-[0-9a-f]{16}/);
			expect(text).toContain("Use recall_tool_result");
			expect(result.details?.toolResultRef).toMatch(/^read-[0-9a-f]{16}$/);
			rmSync(storeDir, { recursive: true, force: true });
		} finally {
			if (previousAgentDir === undefined) delete process.env.NANOPI_CODING_AGENT_DIR;
			else process.env.NANOPI_CODING_AGENT_DIR = previousAgentDir;
		}
	});
});
