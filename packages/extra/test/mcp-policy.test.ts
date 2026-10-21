import { describe, expect, it } from "vitest";
import { isMcpToolName, MCP_MAIN_AGENT_BLOCK_REASON, MCP_SUBAGENT_ONLY_GUIDELINE } from "../src/mcp-policy.ts";

/** The rule the block and the prompt both state: mcp__* is subagent-only, `mcp` is the way in. */
describe("mcp policy", () => {
	it("recognizes raw MCP tool names only", () => {
		expect(isMcpToolName("mcp__filesystem__read_file")).toBe(true);
		expect(isMcpToolName("mcp")).toBe(false);
		expect(isMcpToolName("read")).toBe(false);
	});

	it("points a blocked call at the shell instead of leaving it dead-ended", () => {
		expect(MCP_MAIN_AGENT_BLOCK_REASON).toContain("`mcp`");
		expect(MCP_MAIN_AGENT_BLOCK_REASON).toContain("server + tool + args");
		expect(MCP_MAIN_AGENT_BLOCK_REASON).toContain("subagent");
	});

	it("describes the shell shape in the system prompt guideline", () => {
		expect(MCP_SUBAGENT_ONLY_GUIDELINE).toContain("`mcp`");
		expect(MCP_SUBAGENT_ONLY_GUIDELINE).toContain("subagent runs the real mcp__* tool");
		expect(MCP_SUBAGENT_ONLY_GUIDELINE).toContain("unchanged");
		expect(MCP_SUBAGENT_ONLY_GUIDELINE).toContain("Never call mcp__* directly");
	});
});
