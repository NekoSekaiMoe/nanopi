/**
 * MCP isolation policy: MCP tools (`mcp__*`, provided by the mcp-lite bundled
 * extra) are usable only inside subagents. The main agent's interceptor blocks
 * every `mcp__*` call and the system prompt states the rule; subagent children
 * run without this extension, so the block never applies there.
 */

export const MCP_TOOL_PREFIX = "mcp__";

export function isMcpToolName(toolName: string): boolean {
	return toolName.startsWith(MCP_TOOL_PREFIX);
}

export const MCP_MAIN_AGENT_BLOCK_REASON =
	"MCP tools are subagent-only: the main agent cannot call them. Delegate the MCP work to a subagent (the subagent tool) instead.";

/** System-prompt guideline injected while the mcp subsystem is enabled. */
export const MCP_SUBAGENT_ONLY_GUIDELINE =
	"MCP tools (names starting with mcp__) are available to subagents only; delegate MCP work to a subagent instead of calling them directly.";
