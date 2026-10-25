# pi-lsp-mini

Lean LSP extension for the [pi](https://github.com/earendil-works/pi) coding agent.
Three features, minimal prompt footprint (~660 tokens measured: full JSON
schemas + descriptions + snippets of all 5 tools; zero injected system
instructions):

- **Diagnostics** — `lsp_diagnostics` on a file or a whole directory; issues are
  also appended automatically after every `write`, and after every `edit` when
  `editDiagnostics` is enabled (see below).
- **Call relations** — `lsp_callgraph` walks incoming/outgoing call hierarchy
  recursively (who calls this function / what it calls).
- **Batch replace / delete** — `lsp_rename` (scope-aware workspace rename) and
  `lsp_delete` (removes a function plus every standalone call-site line;
  non-standalone usages are listed for manual cleanup, dry-run by default).

Also: `lsp_references`, `/lsp` command, post-edit auto re-check after
rename/delete.

## Tools

| Tool | What it does |
| --- | --- |
| `lsp_diagnostics` | Errors/warnings for a file or directory (`severity` filter). Omit `path` to scan cwd. |
| `lsp_callgraph` | Callers/callees tree around a function (`direction`, `depth` 1-4). |
| `lsp_references` | All usages of a symbol. |
| `lsp_rename` | Workspace rename. `apply=false` for dry-run. Applies + re-checks diagnostics. |
| `lsp_delete` | Delete declaration + standalone call lines. Dry-run by default, `apply=true` executes. |

All positions are 1-based (`line`, `character`); columns are auto-snapped to the
nearest identifier, so off-by-one is tolerated.

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
`rootMarkers`, `diagnosticsWaitMs`, `settings`, `initializationOptions`,
`compileCommandsProbe` (bool, cpp default true), `enabled`.

## Diagnostics after edit (opt-in)

A diagnostic report attached to an edit is only useful if it describes the
content the edit just wrote. Language servers publish the analysis of the
snapshot they were holding before the change went out, so the first publish that
arrives after an edit routinely belongs to the *previous* content — reporting it
shows the model errors it just fixed, or errors it never introduced. The module
therefore stamps every publish with a revision and waits only for one newer than
the edit.

Disabled by default; enable it in `~/.nanopi/agent/lsp.json`:

```json
{ "editDiagnostics": { "enabled": true, "timeoutMs": 8000, "errorsOnly": false, "maxDiagnostics": 8 } }
```

`timeoutMs` bounds the wait (`0` returns nothing), `errorsOnly` drops warnings,
`maxDiagnostics` caps the report per file. No matching server, a crashed server,
an unreadable file or a timeout all return the edit result unchanged: this path
never turns a successful edit into a failed one.

## Install

From this repository:

```bash
pi -e ./packages/pi-lsp-mini/src/index.ts
```

The extension has no runtime npm dependencies — the only requirement is that the
language-server binaries you want are on PATH (or configured in
`~/.nanopi/agent/lsp.json`).

## Notes

- Prompt budget: all 5 tools cost ~660 request tokens (schemas serialized).
  Tool texts live in `src/schemas.ts` — keep them lean when editing.

- TypeScript note: neither `tsserver` nor `tsc` is an LSP server — `tsserver
  --stdio` speaks tsserver's own protocol, not LSP, and an LSP client will
  time out on `initialize`. That's why the typescript entry uses LSP wrappers
  around tsserver (`typescript-language-server`, or `vtsls` which ships with
  some global installs) instead of `tsserver` itself.

- Delete heuristics: only *standalone* statement lines (`foo(x);`, `await foo()`,
  `defer foo()`, multi-line argument lists) are removed automatically. Usages in
  assignments, arguments, or callbacks are reported as `✋ manual`.
- Rename/delete re-open changed files on the server and re-run diagnostics,
  reporting new errors introduced by the change.
