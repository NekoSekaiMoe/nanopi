# Agent Note: LSP answers travel with the file, not after the edit

Status: implemented

## Problem

`pi-lsp-mini` could report diagnostics, list references, walk a call graph,
rename and delete — but not answer the two questions a model asks most often
while reading code: *what is this symbol's signature* and *where is it declared*.
Both were answered by `read`, at the cost of a whole file, and in the definition
case by a `grep` plus a second `read`.

The diagnostics side had the mirror-image gap. A session learned that a file was
broken only *after* it wrote to it (`write` always reports, `edit` opt-in), or
later still, from a failing build. So a file that arrived broken cost a full
round: the model read it, edited it, was told about errors that predated the
edit, and then had to work out which half was its own.

## Decision

Four tools become seven, and one hook becomes two. (A later change folded
`lsp_references` and `lsp_callgraph` into `lsp_query`, so the count is six — see
[2026-10-27-lsp-query-merge](./2026-10-27-lsp-query-merge.md).)

**`lsp_hover` / `lsp_definition`** take `path` plus either `line`/`character` or a
`symbol` name. The name resolves through the server's `textDocument/documentSymbol`
(a class, a method, a qualified `Class.method`), with a scan of the file text as
the fallback for servers that do not implement it. The reason for accepting a
name at all is the point of the tool: a model asking "what does `parseConfig`
take" knows the name, not the column, and forcing it to find the column sends it
back to reading the file. A name that neither source can place is reported as not
found rather than guessed — a hover answered for the wrong symbol costs more than
no answer.

Hover output is clamped to 1600 characters on a line boundary
(`clampHover`). pyright and tsserver answer with the entire doc comment and
rust-analyzer with the item's attributes; at full length the answer costs more
than the read it replaces, and cutting mid-line would leave a fenced code block
open.

**`read` carries the errors a file already has** (`readDiagnostics` in
`~/.nanopi/agent/lsp.json`, on by default). The report is attached to the read
result through the same `tool_result` hook and the same `appendReport` the
post-edit check uses, so the model sees the code and the state of the code in one
message.

Four properties make that safe to leave on:

- Errors only (`maxSeverity: 1`). Warnings on a freshly opened file are mostly
  whatever the project's config enforces, and a report full of them is one the
  model learns to skip.
- A 4s budget, on a hook that can only *replace* a tool result, never delay a
  turn indefinitely. A slow server costs a slightly late read.
- A publish counter is taken before the file is opened, and only a publish newer
  than that counter counts (`manager.markFor` / `diagnosticsSince`). A server that
  answers `didOpen` with the content it was already holding contributes nothing
  instead of contributing stale errors.
- No report is never a failure: no matching server, a dead one, an unreadable
  file, a file over `maxFileBytes`, and a timeout all produce the untouched read
  result.

Both new tools share the existing per-call `timeoutMs` budget and the
`$/cancelRequest` cancellation, so a cold server is a slow answer, not a hung
turn.

## Alternatives considered

**Require a line and a column for hover and definition.** Simpler (no symbol
resolution, no fallback), and defensible — an editor's hover always has a cursor.
It also would have moved the problem back to `read`: the model would have to open
the file to find a column before it could ask about a signature.

**Ask the model for a text snippet instead of a name.** No dependency on
`documentSymbol`, and `grep`-like matching is something the model already
understands. Rejected because it does not distinguish a symbol from the same word
inside a string literal or a comment, which is exactly the case where a wrong
answer is worse than none.

**Attach diagnostics to `read` by running the language server's whole-file
diagnostics synchronously with no budget.** Would report everything instead of a
window. On a cold `rust-analyzer` or a monorepo `tsserver` that turns the most
frequent tool in a session into a multi-second stall.

**Attach *all* severities.** More information, and the model could filter. In
practice warnings dominate the output on a freshly opened file, and a model that
learns to ignore the block has lost the errors with it.

**Report at read time only, and drop the post-edit report.** One hook instead of
two. Rejected: the post-edit report is what tells the model it introduced the
error, and a read afterwards may not happen for several turns.

**A single `lsp` tool with several actions** (the shape the reference
implementation uses). One declaration instead of seven, but every action's
parameters are then declared for every call, and the model has to be told which
action reads or writes. Separate tools keep each schema to what that call needs,
which is the budget that matters.

## Consequences

- Per signature, one hover instead of one file read; per definition, a `file:line`
  instead of a grep and a read. The prompt budget grows by roughly 330 tokens
  (measured: serialized schemas went ~660 → ~990), which the saved file reads pay
  back on the first use.
- A session that opens a broken file now starts from where the file actually is,
  instead of discovering it one round later.
- The read path gained a language-server call in front of it. It is bounded and
  fails silent, but it is not free: `readDiagnostics.enabled: false` is the escape
  hatch, and `maxFileBytes` keeps large files (rarely the ones being edited) from
  paying for it at all.
- The trade differs from `editDiagnostics` on purpose: `edit` runs far more often
  per turn than `read` and sits on the latency path of every change, so that check
  is opt-in while this one is opt-out. Both are documented side by side in the
  module README.
- Two sources now feed one `manager`: a hover, a definition and a read share the
  same server process, so a cold start is paid once for all three.
- Not delivered: `rename_file` via `workspace/willRenameFiles`. Researched and
  deferred — see
  [the rename_file note](../../rejected/feature/2026-10-27-lsp-rename-file-via-willrenamefiles.md).
