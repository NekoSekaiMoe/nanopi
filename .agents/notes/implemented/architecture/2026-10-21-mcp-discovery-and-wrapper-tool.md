# Agent Note: MCP discovery, the `mcp` shell tool, and platform-correct server lookup

Status: implemented

## Problem

Three defects shared one root: MCP and LSP were wired for the machine they were
developed on.

1. `pi-lsp-mini` and `mcp-lite` both probed PATH with
   `accessSync(dir/<name>, X_OK)`. On Windows the installed executable is
   `npx.cmd` / `typescript-language-server.cmd`, so the extension-less probe
   never matched and every server read as "not installed" — the bug reported
   for LSP, and structural for MCP too.
2. MCP servers had to be listed by hand in `~/.nanopi/mcp.json`. Every other
   client already had them somewhere documented, and copying the list over is
   exactly the friction that makes an integration unused.
3. `mcp__*` tools were subagent-only *and* unreachable: the extra module blocked
   them in the main session, nothing replaced them, and the prompt said "delegate
   to a subagent", which left the model to invent a brief for a tool call it could
   not name precisely. MCP was effectively off for the main agent.

## Decision

**Executable lookup is shared and platform-aware.** `src/extras/*/src/executables.ts`
resolves a name through `which` (`where` on Windows) first, then walks PATH with
`PATHEXT` (defaults `.COM;.EXE;.BAT;.CMD`), then hands back the absolute path. The
absolute path is what gets spawned. On native Windows a `.cmd`/`.bat` result is
launched as `cmd.exe /d /s /c <path> …`, matching `cross-spawn`; WSL keeps the
POSIX spawn, because a Windows shim started from a Linux process takes different
arguments, but still resolves the shims interop puts on PATH. This is the same
split Codex makes (`rmcp-client/src/program_resolver.rs`: `which` on Windows,
identity on Unix) and pi reaches through `cross-spawn` for.

**Discovery is a known-path list, merged below the user's files.** `discover.ts`
reads Claude Desktop, Cursor, Windsurf, VS Code, Codex, ZCode, OpenCode, and the
project-level `.mcp.json` / `.vscode/mcp.json` / `.cursor/mcp.json` /
`.codex/config.toml` / `.agents/mcp.json`, normalizes both server shapes
(`command`+`args` and OpenCode's argv array; `type`/`transport`/none; `url` means
remote; `enabled: false`/`disabled: true` skipped), expands `${VAR}` and
`${VAR:-default}`, and returns the source file for each entry. `loadMcpConfig`
keeps `~/.nanopi/mcp.json` and `.nanopi/mcp.json` authoritative: a discovered
entry with the same name never overrides an explicit one.

Discovery is off only by explicit request: `.nanopi/mcp.json` takes a
`discovery` block with `mode: "auto"|"off"`, `globalOnly`, `include`, `exclude`.
`globalOnly` exists because a project config file can start an arbitrary
command, so a checked-out repository must be able to lose that privilege from the
user-level file.

**The main agent gets one shell tool, `mcp`, and every MCP call takes that
shape.** The main agent calls `mcp` with `server` + `tool` + `args`; the shell
spawns a subagent with its tool set pinned to `mcp__<server>__<tool>,read`; the
subagent calls the real tool with the arguments passed through unchanged; the
server's output comes back verbatim. No `server` lists the servers and their
sources, no `tool` lists one server's tools. The isolated child turn is the
point: the external payload never enters the main transcript, the child cannot
touch the tree or block a writing subagent, and the model never has to name an
`mcp__*` tool it cannot see. If a build has no `subagent` tool the shell runs the
call in-process rather than leaving the agent without MCP. The extra module keeps
blocking raw `mcp__*` in the main session and names the shell in its block
reason, its system-prompt guideline, and the shell's own tool description.

Pass-through is a contract, not a nicety: the brief tells the child to send the
arguments it was given without adding, renaming, or dropping a field, and to
return the tool's text verbatim with no summary. Without both halves the result
the main agent sees is the child's rewrite of an external payload, and a retry
with different arguments is an unlogged second request to an external service.

**Nothing adds `mcp__*` to a child's default tools.** pi-subagent-mini's
`DEFAULT_TOOLS` is `read,bash,grep,find,ls`; the shell names the one tool it
needs. Declaring every `mcp__*` on every child would put all server schemas into
each child's prompt and cache prefix for a capability most children never use,
so the `tools` parameter description, the subagent description tail, and the
CHANGELOG all say that a hand-written spawn has to name the tool it wants.

**LSP coverage grows to 31 entries, and root markers accept globs.** Ruby, PHP,
Java, Kotlin, C#, F#, Swift, Zig, Lua, Dart, Haskell, Elixir, Erlang, Scala,
Clojure, OCaml, bash, Terraform, Dockerfile, Vue, Svelte, CMake, protobuf, SQL,
Solidity and SystemVerilog join the original five, plus `basedpyright-langserver`
as a Python candidate. A `.sln`/`.csproj`/`*.xcodeproj` marker is a glob because
those projects have no fixed configuration file name, and an exact-match walk
would climb past the project root and fall back to cwd. `/lsp` lists the missing
entries alongside the installed ones, so "my language is unsupported" is
answerable.

## Alternatives considered

- **Scan every client directory, or auto-import without a switch.** Convenient,
  and wrong: a server that appears without being asked for is a security
  surprise, and none of the four harnesses we compared does it. Codex layers
  `<CODEX_HOME>/config.toml` plus trusted `.codex/config.toml` layers and strips
  credential-bearing keys from project layers; pi reads `mcp.json` and a
  project `mcp.json` only when the project is trusted; dsh mounts one plugin per
  server and reads no foreign file; ZCode's import is an explicit user action
  through a settings directory. Known paths plus a visible status line keeps the
  convenience without the surprise.
- **Normalize Claude's `command`+`args` only.** Cursor and Claude share it, but
  OpenCode stores one argv array and VS Code uses a different key and file, so a
  single-shape reader imports nothing from half the clients on a machine.
- **Make `mcp` call the server directly instead of through a subagent.**
  Simplest, and it defeats the isolation the block exists for: a large file dump
  from a server would land in the main transcript, which is what the subagent hop
  prevents. The in-process path exists only for builds with no `subagent` tool.
- **Teach the main agent to spawn a subagent by hand for each MCP call.** That is
  what the old prompt said, and it failed in practice: the model has to name
  `mcp__<server>__<tool>` exactly and write a GOAL/CONTEXT brief for a one-line
  call. The shell owns the brief, so the model states server, tool, and args.
- **Do the whole thing in the LSP/MCP modules instead of a shared file.** The two
  copies would drift on exactly the platform edge (WSL lookup versus WSL spawn)
  that made the bug hard to see, so each extra keeps its own small copy of the
  same rules, including the `.cmd`-needs-`cmd.exe` wrapper only MCP spawns.

## Consequences

- A machine with Cursor or Claude Desktop configured gets MCP tools without
  writing a config, and `/mcp` says where each server came from so the import is
  auditable rather than magic.
- The `mcp` shell costs a spawn (a child session) per call: roughly a second of
  startup plus the child's own prompt. For repeated calls in one task the model
  can still use `subagent` directly with several `mcp__*` tools named in `tools`;
  the shell is for the one-shot case.
- Discovery syntax support is intentionally partial: a small TOML subset reader
  covers Codex's `[mcp_servers.*]` tables, not full TOML. An exotic config (inline
  tables, multi-line strings) is skipped with a reported problem instead of
  silently mis-parsed.
- LSP entries for uncommon languages are unverified binaries: a wrong command
  name is invisible until someone with that toolchain runs `/lsp`, which now at
  least lists the entry as "configured but not installed".
