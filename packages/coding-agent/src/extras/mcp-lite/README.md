# mcp-lite

Lean MCP (Model Context Protocol) client for nanopi — a slim port of
[irahardianto/pi-mcp-extension](https://github.com/irahardianto/pi-mcp-extension)
(MIT): stdio and streamable-http transports, `initialize` / `tools/list` /
`tools/call` with cancellation, layered config, and discovery of the config
files other clients already have. No OAuth, health pings, or reconnection
machinery.

## The call path

Every MCP call is one round trip:

```
main agent --mcp(server, tool, args)--> mcp shell
                                         |  spawn subagent, tools = mcp__<server>__<tool>,read
                                         v
                                       subagent --mcp__<server>__<tool>(args)--> MCP server
                                         |  passes the arguments through unchanged
                                         v
main agent <------------- the tool's output, verbatim
```

- **`mcp` — the shell the main agent calls.** Without `server` it lists the
  servers and where each came from; without `tool` it lists that server's tools;
  with both it spawns a subagent and returns that child's report. The subagent
  hop is the point: the external payload never lands in the main conversation,
  and the model never has to name an `mcp__*` tool it cannot see. If a build has
  no `subagent` tool, the shell runs the call in-process instead of failing.
- **`mcp__<server>__<tool>` — the server's own tools, subagent-only.** They
  register with `defaultActive: false`, so the main agent never declares them;
  the shell activates exactly the one it needs in the child's `tools` list. None
  are added to a child's defaults (pi-subagent-mini's `DEFAULT_TOOLS` is
  `read,bash,grep,find,ls`), so a hand-written `spawn` that wants MCP has to
  name the tool. The extra module blocks every `mcp__*` call in main-agent
  sessions and points the model at the shell.

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

`/mcp` lists connection status, the file each server came from, and any file
that failed to parse. Servers connect eagerly at session start; failed servers
stay visible with their error.

## Discovery

A machine that already configured MCP for another client should not need the
list copied over, so these files are imported automatically and merged *below*
your own `mcp.json` entries (your entry wins on a name clash):

| client | files |
| --- | --- |
| Claude Desktop | `…/Claude/claude_desktop_config.json` (Roaming / `~/.config` / `Application Support`) |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `…/Code/User/mcp.json` (the `servers` key) |
| Codex | `~/.codex/config.toml` (`[mcp_servers.<name>]`) |
| ZCode | `~/.zcode/cli/config.json` (`mcp.servers`) |
| OpenCode | `~/.config/opencode/opencode.json[c]` |
| project | `.mcp.json`, `.vscode/mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.agents/mcp.json` |

Both shapes are normalized: `command` + `args` or a single argv array,
`type`/`transport`/nothing as the discriminator, `url` meaning remote,
`enabled: false` / `disabled: true` meaning skipped. `${VAR}` and
`${VAR:-default}` are expanded from the environment.

Discovery is deliberately not "scan everything": only known paths, only files
that exist, and a status line per source. A server that appears without being
asked for is a security surprise, not a convenience. `.nanopi/mcp.json` can
narrow it:

```jsonc
{
	"discovery": {
		"mode": "auto",          // "off" disables the import entirely
		"globalOnly": false,     // true: never read project-level files
		"include": ["./team-mcp.json"],  // extra files, project-relative
		"exclude": ["~/.cursor/mcp.json"]
	}
}
```

`globalOnly` exists because a project file can start an arbitrary command: set
`"globalOnly": true` in your global `mcp.json` and a checked-out repository can
never add servers.

## Windows and WSL

stdio commands are resolved on `PATH` through `PATHEXT`/`where` before spawning,
so the `npx` a user configures finds `npx.cmd`, and the absolute path is what
gets spawned — `spawn("npx")` without a shell is `ENOENT` on Windows, which used
to make every `npx`-based server look broken. A `.cmd`/`.bat` shim is launched
through `cmd.exe /d /s /c` the way `cross-spawn` does, since Node refuses to
execute the shim file directly.
