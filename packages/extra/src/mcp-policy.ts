/**
 * MCP isolation policy: MCP tools (`mcp__*`, provided by the mcp-lite bundled
 * extra) are usable only inside subagents. The main agent's interceptor blocks
 * every `mcp__*` call and the system prompt states the rule; subagent children
 * run without this extension, so the block never applies there.
 *
 * The main agent is not cut off, though: mcp-lite registers one shell tool
 * (`mcp`), and every MCP call takes that shape — the main agent calls `mcp`
 * with server + tool + args, `mcp` spawns a subagent, the subagent calls the
 * real `mcp__<server>__<tool>` with the arguments passed through, and the
 * result comes back. The isolated child turn is what keeps the external payload
 * out of this conversation, so the shell is a normal tool and is not blocked
 * here.
 */

export const MCP_TOOL_PREFIX = "mcp__";

export function isMcpToolName(toolName: string): boolean {
	return toolName.startsWith(MCP_TOOL_PREFIX);
}

export const MCP_MAIN_AGENT_BLOCK_REASON =
	"MCP tools are subagent-only: the main agent cannot call them. Call the `mcp` tool with server + tool + args instead; it runs the real tool inside a subagent and returns its output.";

/** System-prompt guideline injected while the mcp subsystem is enabled. */
export const MCP_SUBAGENT_ONLY_GUIDELINE =
	"Reach MCP servers only through the `mcp` tool: it takes server + tool + args, a subagent runs the real mcp__* tool with those arguments unchanged, and the output comes back. Never call mcp__* directly here; it is subagent-only and blocked.";
