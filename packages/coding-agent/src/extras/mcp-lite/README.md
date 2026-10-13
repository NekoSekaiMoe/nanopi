# mcp-lite

Lean MCP (Model Context Protocol) client for nanopi — a slim port of
[irahardianto/pi-mcp-extension](https://github.com/irahardianto/pi-mcp-extension)
(MIT): stdio and streamable-http transports, `initialize` / `tools/list` /
`tools/call` with cancellation, and layered config. No OAuth, health pings, or
reconnection machinery.

**MCP is subagent-only.** Tools register as `mcp__<server>__<tool>` with
`defaultActive: false`, so the main agent never declares them; subagent
children load this extension and activate the tools with `--tools mcp__*`
(pi-subagent-mini forwards both when the extra module's `mcp` subsystem switch
is on). The extra module additionally blocks every `mcp__*` call in
main-agent sessions and states the rule in the system prompt.

## Configuration

`~/.nanopi/mcp.json` (global) with per-server overrides in
`.nanopi/mcp.json` (project):

```jsonc
{
	"mcpServers": {
		"filesystem": {
			"transport": "stdio",
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
		},
		"remote": {
			"transport": "http",
			"url": "https://mcp.example.com/mcp",
			"headers": { "authorization": "Bearer …" }
		}
	}
}
```

`/mcp` lists connection status. Servers connect eagerly at session start;
failed servers stay visible with their error.
