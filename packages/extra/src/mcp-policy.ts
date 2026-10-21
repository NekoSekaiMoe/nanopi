/**
 * MCP isolation policy: MCP tools (`mcp__*`, provided by the mcp-lite bundled
 * extra) are usable only inside subagents. The main agent's interceptor blocks
 * every `mcp__*` call and the system prompt states the rule; subagent children
 * run without this extension, so the block never applies there.
 *
 * The main agent is not cut off, though: mcp-lite registers one wrapper tool
 * (`mcp`) that lists the servers and delegates a call to a subagent, so the
 * isolated child turn is what keeps the external payload out of this
 * conversation. The wrapper is a normal tool and is not blocked here.
 */

export const MCP_TOOL_PREFIX = "mcp__";

export function isMcpToolName(toolName: string): boolean {
	return toolName.startsWith(MCP_TOOL_PREFIX);
}

export const MCP_MAIN_AGENT_BLOCK_REASON =
	"MCP tools are subagent-only: the main agent cannot call them. Use the `mcp` tool (it delegates to a subagent), or the subagent tool directly.";

/** System-prompt guideline injected while the mcp subsystem is enabled. */
export const MCP_SUBAGENT_ONLY_GUIDELINE =
	"MCP servers are reached through the `mcp` tool (it runs the call inside a subagent). Raw mcp__* tools are subagent-only and blocked here.";
