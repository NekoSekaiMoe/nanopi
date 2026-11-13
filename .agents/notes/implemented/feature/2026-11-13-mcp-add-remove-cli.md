# Agent Note: `nanopi mcp add|remove|list` writes the config mcp-lite reads

Status: implemented

## Problem

mcp-lite could read `~/.nanopi/mcp.json` and `.nanopi/mcp.json`, discover a
dozen other clients' config files, and show all of it in `/mcp`. It could not
write. So the one thing an MCP integration actually needs — "add this server" —
was a hand-edit of a JSON document whose server shape depends on the transport:
`command` + `args` for stdio, `url` + `headers` for http, and a `transport`
discriminator that every other client spells differently.

Reading and writing the same file from two places also means the path resolution
has to live in one of them. The webui already reads MCP config through
`loadMcpConfig(cwd, { agentDir })`; a CLI that re-derived `agentDir` from
`homedir()` would read one file and write another on any machine with
`NANOPI_CODING_AGENT_DIR` set.

## Decision

**The writer lives in mcp-lite (`src/write.ts`), not in the CLI.** The CLI
(`src/cli/mcp-command.ts`) parses argv and prints; every path, parse, and write
belongs to the module that owns the format. `resolveWriteTarget(scope, { cwd,
agentDir })` is the one place that decides which of the two files a write goes
to, and it takes the host's `agentDir` the same way `loadMcpConfig` does.

**A write preserves the document.** The file is read as `Record<string, unknown>`,
one `mcpServers` entry is set or deleted, and everything else — the `discovery`
block, servers this command did not touch, the existing indent, a UTF-8 BOM —
comes back unchanged. The file is a hand-edited document that this command edits,
not a file this command owns. A file that does not parse is reported with the
parse error instead of replaced: the servers in it are the user's, and the parse
failure is the last chance to say so before they are gone.

**The write is one rename.** `writeFileSync(<sibling tmp>)` then `renameSync`. The
file is read at every session start, so a half-written one would report "no
servers configured" instead of failing.

**A clashing name is refused unless `--force` says otherwise.** `add` typed twice
must not silently replace a server someone spent time configuring, and the error
names the flag that resolves it.

**`--` ends the option parsing, because the server's argv is not ours.** `npx -y
@pkg … --some-flag` is the common case, and the `--some-flag` belongs to the
server. Everything after `--` is passed through verbatim. The same input typed
without `--` (`add fs npx -y pkg`) is accepted too: after the name, the first
non-flag word starts the server argv. That grammar is unambiguous because `add`
owns exactly one positional — the server name.

**`remove` covers nanopi's two files, and says what it cannot reach.** With no
scope flag it removes the name from both. A name that still resolves afterwards
came from a discovered file (Cursor, Claude Desktop, …), which nanopi reads and
does not write: the message names that file rather than claiming success or
leaving the user editing the wrong one.

`list` is the merged view — `loadMcpConfig`, one line per server with the file it
came from. A project-only list would omit the discovery results, and the question
`list` answers is "what can this session reach".

## Alternatives considered

- **`nanopi mcp add` as a module command rather than a CLI subcommand.** A module
  command needs a session, and a session needs a model and a credential. Adding a
  server is exactly the step a container does before it has either, and the
  existing `auth`/`webui` subcommands already establish "runs before the session
  and exits" as the shape for this.
- **Rewrite the file from the parsed config (`loadMcpConfig` output).** Tempting
  because it normalizes every server shape for free, and wrong because that
  output is the *merged* view: it contains discovered servers from other clients,
  and writing it back would copy Cursor's and Claude's entries into nanopi's file
  on the first `add`.
- **Let `--force` overwrite a server silently when it came from another file.**
  `add` writes one file. Replacing a Cursor-configured server by writing
  nanopi's own entry would shadow it (the explicit entry wins on a name clash)
  while the other file still says something different, which is the opposite of
  what "replace" means.
- **JSON5 or comments in `mcp.json`.** The reader takes strict JSON with a BOM
  tolerance, and teaching the writer a second grammar would make the two halves
  disagree about what the file contains. Users who want comments keep them
  outside the file.

## Consequences

- `mcp add`/`remove` work with no model, no credential, and no TTY, so setup is
  scriptable (`nanopi mcp add … && nanopi -p "…"`).
- The preserve-everything rule means a user who restructures their file by hand
  (moves `discovery` to the project file, reorders servers) keeps that structure
  through an `add`. The cost is that the writer cannot normalize a malformed
  entry: `parseServerEntry` rejects it on read, and `add` leaves it alone.
- Two files, one name: `add --project` can create a project entry that shadows a
  global one of the same name. That is the documented precedence
  (`loadMcpConfig` merges project over global), and `list` prints both origins so
  the shadowing is visible.
- `remove` on a discovered name exits 1. Scripting `mcp remove` therefore has to
  tolerate "it was never ours", which is the truthful answer rather than a
  no-op success.

## Testing

`packages/coding-agent/test/mcp-command.test.ts` covers the argv grammar
(`--`, no `--`, both transports, `--project`, `--force`) and the file semantics
against a temp `agentDir` / cwd: other top-level keys survive an add, a duplicate
is refused then replaced, the project file is written on `--project`, `remove`
covers both files, and a malformed file throws instead of being overwritten.
