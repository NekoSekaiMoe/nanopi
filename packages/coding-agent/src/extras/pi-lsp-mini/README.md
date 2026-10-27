# pi-lsp-mini

Lean LSP extension for the [pi](https://github.com/earendil-works/pi) coding agent.
Four features, minimal prompt footprint (all 5 tools measured at 2966 characters
of JSON schema + descriptions + snippets, ~740 tokens; zero injected system
instructions):

- **Signatures** — `lsp_hover` and `lsp_definition`: what a symbol's type is and
  where it is declared, without reading the file for either.
- **Diagnostics** — `lsp_diagnostics` on a file or a whole directory; existing
  errors are also appended to every `read` ([`readDiagnostics`](#diagnostics-before-read)),
  issues are appended after every `write`, and after every `edit` when the
  opt-in [`editDiagnostics`](#diagnostics-after-edit) check is enabled.
- **Call relations** — `lsp_query` with `kind: "callgraph"` walks
  incoming/outgoing call hierarchy recursively (who calls this function / what
  it calls); a server without call hierarchy answers with references instead.
- **Batch replace / delete** — `lsp_edit` with `kind: "rename"` (scope-aware
  workspace rename) or `kind: "delete"` (removes a function plus every
  standalone call-site line; non-standalone usages are listed for manual
  cleanup). Both dry-run unless `apply=true`.

Also: `lsp_query` with `kind: "references"` (the default), `/lsp` command,
post-edit auto re-check after rename/delete.

## Tools

| Tool | What it does |
| --- | --- |
| `lsp_diagnostics` | Errors/warnings for a file or directory (`severity` filter). Omit `path` to scan cwd. |
| `lsp_hover` | Signature and doc comment at a position, or of a named `symbol`. |
| `lsp_definition` | `file:line` where the symbol at a position (or a named `symbol`) is declared. |
| `lsp_query` | `kind: "references"` (default) lists all usages of a symbol; `kind: "callgraph"` walks callers/callees (`direction`, `depth` 1-4). |
| `lsp_edit` | `kind: "rename"` (`newName`) or `kind: "delete"`. Dry-run unless `apply=true`; applies + re-checks diagnostics. |

All positions are 1-based (`line`, `character`); columns are auto-snapped to the
nearest identifier, so off-by-one is tolerated.

`lsp_hover` and `lsp_definition` also accept `symbol` instead of
`line`/`character`. A model that asks "what does `parseConfig` take" knows a
name, not a column, and demanding the column would send it back to reading the
file — exactly what these two tools exist to avoid. The name is resolved by the
server's own `textDocument/documentSymbol` (so a class, method, or a qualified
`Class.method` all work), with a text scan as the fallback for servers that do
not implement it. A name no source can place is reported as not found instead of
guessed: a hover answered for the wrong symbol costs more than no answer.

Hover output is capped at 1600 characters on a line boundary, because pyright
and tsserver answer with the entire doc comment and rust-analyzer with the
item's attributes, which at full length costs more than the file read it
replaces.

## Language servers

Built-in (auto-enabled if the binary is on PATH):

| id | binaries | files |
| --- | --- | --- |
| typescript | `typescript-language-server --stdio`, fallback `vtsls --stdio` | .ts .tsx .mts .cts .js .jsx .mjs .cjs |
| python | `pyright-langserver --stdio`, `basedpyright-langserver --stdio`, `pylsp` | .py .pyi |
| go | `gopls` | .go |
| rust | `rust-analyzer` | .rs |
| cpp | `clangd` (+ `--background-index`) | .c .h .cpp .cc .cxx .hpp .hh .hxx .cu .cuh |
| ruby | `ruby-lsp`, `solargraph stdio` | .rb .rake .gemspec |
| php | `intelephense --stdio`, `phpactor language-server` | .php |
| java | `jdtls` | .java |
| kotlin | `kotlin-language-server` | .kt .kts |
| csharp | `csharp-ls`, `omnisharp --languageserver` | .cs |
| fsharp | `fsautocomplete --adaptive-lsp-server-enabled` | .fs .fsx .fsi |
| swift | `sourcekit-lsp` | .swift |
| zig | `zls` | .zig .zon |
| lua | `lua-language-server` | .lua |
| dart | `dart language-server --protocol=lsp` | .dart |
| haskell | `haskell-language-server-wrapper --lsp` | .hs .lhs |
| elixir | `elixir-ls` | .ex .exs |
| erlang | `erlang_ls` | .erl .hrl |
| scala | `metals` | .scala .sc |
| clojure | `clojure-lsp` | .clj .cljs .cljc .edn |
| ocaml | `ocamllsp` | .ml .mli |
| bash | `bash-language-server start` | .sh .bash .zsh .ksh |
| terraform | `terraform-ls serve` | .tf .tfvars |
| dockerfile | `docker-langserver --stdio` | .dockerfile |
| vue | `vue-language-server --stdio`, `vls` | .vue |
| svelte | `svelteserver --stdio` | .svelte |
| cmake | `cmake-language-server` | .cmake |
| protobuf | `buf beta lsp --stdio` | .proto |
| sql | `sqls` | .sql |
| solidity | `nomicfoundation-solidity-language-server --stdio` | .sol |
| systemverilog | `svlangserver` | .v .sv .svh .vh |

`/lsp` lists the servers that resolved and, separately, the entries whose binary
is missing, so an unsupported file type can be traced to "not installed".

**Windows / WSL**: PATH lookups run through `which` (`where` on Windows) before
any directory walk, so `.cmd`/`.bat` shims installed by npm/pnpm (`npx.cmd`,
`typescript-language-server.cmd`) and Windows Store aliases are found, and the
server is spawned from its absolute path — `spawn("<name>.cmd")` without a shell
is `ENOENT`, the classic Windows-only "language server not installed" report.
Git Bash, Cygwin and MSYS spell the same executables differently, and calling a
Windows shim from a POSIX process needs `cmd.exe /c`; on those exceptions,
configure the command explicitly (`{ "id": "typescript", "command": "cmd.exe /c
typescript-language-server.cmd --stdio" }`).

`rootMarkers` accepts globs (`*.sln`, `*.csproj`), because .NET and CMake
projects have no fixed configuration file name.

**clangd extras**: project root falls back through `compile_commands.json` → `CMakeLists.txt` → `Makefile` → `.git`; if `compile_commands.json` lives in a build subdirectory (`build/`, `cmake-build-*/`, `build-*/`, `out/`, ...), it is auto-detected and passed via `--compile-commands-dir` (clangd's own detection only covers a plain `build/`). Absolute-path commands are supported (e.g. `/usr/lib/llvm-19/bin/clangd`).

Override or extend via `~/.nanopi/agent/lsp.json`:

```json
{
  "servers": [
    { "id": "python", "enabled": false },
    { "id": "luau", "command": "luau-lsp lsp", "args": [], "include": [".luau"], "rootMarkers": [".luaurc", ".git"] }
  ]
}
```

Each entry: `id`, `command` (string or list of alternatives; first on PATH wins,
inline args allowed, absolute paths supported), `args`, `include` (extensions),
`rootMarkers`, `diagnosticsWaitMs`, `requestTimeout`, `settings`,
`initializationOptions`, `compileCommandsProbe` (bool, cpp default true),
`enabled`.

## Request deadline

Every LSP request carries a deadline. The default is 30s, configurable at the top
level of the same file and overridable per server:

```json
{
  "requestTimeout": 30000,
  "servers": [{ "id": "rust", "requestTimeout": 120000 }]
}
```

A cold `rust-analyzer` or a `tsserver` that has to index a monorepo routinely
takes longer than a fixed default, and the only thing the model saw for that was
"tool failed" — no way to tell "no results" from "still working". Raising the
deadline is the fix; retrying a request that was still running was never one.

`lsp_query` and `lsp_edit` also take a per-call `timeoutMs`, so
one expensive call can be given room without changing the setting. On `lsp_diagnostics` the same value replaces the wait allowance
(`diagnosticsWaitMs`), which is how a directory scan of a large project is given
more time to settle.

The value is re-read on every call, so editing `lsp.json` mid-session applies
without restarting.

A deadline is a ceiling on work, so an expired one has to stop the work, not
just stop waiting for it. Two things follow:

- **Expiry cancels the request.** The client sends `$/cancelRequest` for the id
  it gave up on (`jsonrpc.ts`), so the server drops it. Without that, a retry
  queues behind an answer nobody will read, and a bigger deadline only widens
  the window in which that happens.
- **A multi-request tool gets one budget, not one per request.** A `lsp_query`
  call with `kind: "callgraph"` walks the graph breadth-first; `depth=3` on a wide graph is dozens of
  sequential requests, and a per-request deadline would make the tool call's
  real ceiling `depth x fan-out x timeout`. The per-call `timeoutMs` is spent
  once, shared by every hop (`budget.ts`); when it runs out the report keeps what
  it collected and says it was truncated. `lsp_diagnostics` scans servers in
  parallel and waits once, instead of serially per server.

A tool call never blocks for longer than its budget, and no request it abandoned
is left running on the server.

## Diagnostics before read

`read` carries the errors a file already has, so a session that is about to edit
a broken file sees that in the same message as the code instead of one round
later (from a post-edit report, or from a test run that was failing before it
started). On by default; `~/.nanopi/agent/lsp.json`:

```json
{
  "readDiagnostics": { "enabled": true, "maxSeverity": 1, "timeoutMs": 4000, "maxDiagnostics": 8, "maxFileBytes": 524288 }
}
```

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | Run the check at all. `false` turns it off. |
| `maxSeverity` | `1` | 1 reports errors only, 2 adds warnings. Warnings on a freshly opened file are mostly style noise. |
| `timeoutMs` | `4000` | Total budget. On expiry the read result is returned unchanged. |
| `maxDiagnostics` | `8` | Cap on reported diagnostics per read. |
| `maxFileBytes` | `524288` | Larger files are skipped: a big file is usually not the one being edited. |

A clean file reports nothing, and a report is never newer than the read: the
check records the publish counter before opening the file and only accepts a
publish after it, so a server that answers `didOpen` with an older snapshot
produces no output rather than stale errors. Nothing here can fail a `read` —
no matching server, a crashed one, a timeout, and an unreadable file all mean
"no report".

## Diagnostics after edit

`write` always reports what the server says about the file it just wrote. `edit`
does not, by default: an agent loop runs `edit` far more often than `write`, and
a language server on that path is a per-turn latency cost. Turn it on per user in
`~/.nanopi/agent/lsp.json`:

```json
{
  "editDiagnostics": { "enabled": true }
}
```

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `false` | Run the check at all. Anything but `true` is off. |
| `debounceMs` | `500` | Initial pause after `didChange` before looking for a publish. |
| `timeoutMs` | `8000` | Total budget. On expiry the edit result is returned unchanged. |
| `errorsOnly` | `false` | Drop warnings; report errors only. |
| `maxDiagnostics` | `8` | Cap on reported diagnostics per file. |

Two invariants hold regardless of configuration:

- **Freshness.** A server publishes diagnostics for whatever it last saw, so the
  snapshot available right after an edit is usually the *pre*-edit one. The
  check records a publish counter before touching the file and only accepts
  reports newer than that mark; when none arrives inside the budget it reports
  nothing rather than stale errors attributed to this edit.
- **Never fatal.** No matching server, a server that will not start, a file the
  server refuses, or a timeout all mean "no diagnostics". A successful `edit` is
  never turned into a failure by the check.

## Install

From this repository:

```bash
pi -e ./packages/pi-lsp-mini/src/index.ts
```

The extension has no runtime npm dependencies — the only requirement is that the
language-server binaries you want are on PATH (or configured in
`~/.nanopi/agent/lsp.json`).

## Notes

- Prompt budget: all 5 tools cost ~740 request tokens (2966 characters of
  serialized schema, description and snippet). Tool texts live in
  `src/schemas.ts` — keep them lean when editing, and put "when to use this"
  in `promptSnippet` instead of repeating it in `description`.

- TypeScript note: neither `tsserver` nor `tsc` is an LSP server — `tsserver
  --stdio` speaks tsserver's own protocol, not LSP, and an LSP client will
  time out on `initialize`. That's why the typescript entry uses LSP wrappers
  around tsserver (`typescript-language-server`, or `vtsls` which ships with
  some global installs) instead of `tsserver` itself.

- Delete heuristics: only *standalone* statement lines (`foo(x);`, `await foo()`,
  `defer foo()`, multi-line argument lists) are removed automatically. Usages in
  assignments, arguments, or callbacks are reported as `✋ manual`.
- Rename/delete re-open changed files on the server and re-run diagnostics,
  reporting new errors introduced by the change. Both live in `lsp_edit`
  because they share that lifecycle, and both need `apply=true`: a workspace
  edit that a model did not ask to be written is not recoverable from a tool
  message, and the preview costs one extra call.
- The post-`edit` check waits for a publish it can prove is new. Servers that
  only re-publish on `didSave` therefore report nothing there — that is the
  intended trade: silence instead of a stale error blamed on the edit.
