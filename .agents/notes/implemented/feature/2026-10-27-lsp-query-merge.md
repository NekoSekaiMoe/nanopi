# Agent Note: One query tool, and one job per tool text

Status: implemented

## Problem

`pi-lsp-mini` shipped seven tools. Two of them, `lsp_references` and
`lsp_callgraph`, took exactly the same parameters (`path`, `line`, `character`,
`timeoutMs`) and answered the same question at two granularities: who touches
this symbol, and who calls this function. The client already treated them as one
capability — `lsp_callgraph` fell back to `textDocument/references` when the
server had no call hierarchy, because "who calls this" without a call graph is
still "who touches this". So the model was choosing between two tool names to
pick a *detail*, and paying for both names in every request.

The same request paid twice for one argument. `lsp_hover`'s description said
"without reading the file" and its snippet said "without reading the file" in
other words; `lsp_definition` said "without grepping for it", `lsp_references`
"(usages)", `lsp_callgraph` "callers and callees, recursive" — each of them
repeating what the snippet next to it already said. The efficiency argument is
obvious to a model that has both `read` and an LSP tool in front of it; restating
it in the description cost characters on every request and bought nothing.

## Decision

`lsp_references` and `lsp_callgraph` become one tool:

```
lsp_query { path, line, character, kind?: "references" | "callgraph",
            direction?, depth?, timeoutMs }
```

- `kind` defaults to `references`, so the cheaper, more common call needs no
  discriminant.
- `direction` and `depth` are read only on the `callgraph` branch. A server
  without call hierarchy answers the `callgraph` request with a references
  report instead of an error naming the tool the model should have called — the
  answer it wanted, at the granularity the server can give.
- `promptSnippet` takes over the discoverability the two tool names provided:
  "Find usages of a symbol, or trace callers/callees of a function". A `kind`
  field is only usable if the model knows the branches exist.
- Descriptions keep the how-to and the parameter semantics; snippets keep the
  when. No text states the efficiency argument twice.

`lsp_diagnostics`, `lsp_hover`, `lsp_definition`, `lsp_rename` and `lsp_delete`
keep their own names: `diagnostics` has no position and runs the server's push
path, and `hover`/`definition` are single-request tools whose names are their
prompt. Folding them into `lsp_query` would make it `{ path, position?,
kind }` with five meanings.

## Consequences

Measured on the serialized schemas, descriptions and snippets:

| | before | after |
| --- | --- | --- |
| tools | 7 | 6 |
| schema characters | 2703 | 2563 |
| text characters | 811 | 714 |
| prompt tokens | ~990 | ~820 |

- A session that used to call `lsp_callgraph` now calls `lsp_query` with
  `kind: "callgraph"`. There is no alias: the old names are gone, so the model
  reaches for whichever name the current tool list shows.
- The client side lost a `supportsCallHierarchy` early return and a duplicated
  `openFile` + `snapPos` preamble; both branches now run through the same
  position resolution, so `kind: "references"` and `kind: "callgraph"` can no
  longer disagree about off-by-one columns.
- `lsp_query` gained no behavior. Its two branches are the two handlers that
  existed, extracted into functions so the tool definition stays a router.
- The tool surface is now one place where a future merge of `rename`/`delete`
  would land; that change is separate because it moves a destructive default
  (`apply`), and a reviewer should not have to read a text edit and a behavior
  change in the same diff.

## Alternatives considered

**Keep two tools and only delete the duplicated text.** The cheapest option, and
the one with genuinely zero behavioral risk. Rejected because the duplication
being removed was the *justification* for the second tool: once the descriptions
stop arguing "cheaper than grep", `lsp_references` and `lsp_callgraph` are two
names for one schema, and the model still has to pick.

**Merge to three tools: `lsp_query` / `lsp_edit` / `lsp_diagnostics`.** The other
half of the same argument. Deferred, not rejected: `rename` and `delete` share a
destructive, workspace-wide, dry-run-then-apply lifecycle, but combining them
unifies their `apply` default (`rename` true, `delete` false) — a behavior
change that deserves its own diff and its own changelog line.

**Merge `hover` and `definition` into `lsp_query` as two more `kind` values.** One
name, four branches, and all of them take the same `path` + position. Rejected:
their return shapes differ (prose vs `file:line` list), and a single tool whose
description has to cover four unrelated answers loses the one-line "what this
does" a tool name gives the model for free.

**Drop the `kind` field and infer it from `direction`/`depth`.** Saves a
parameter. Rejected: "absent `depth` means references" is a rule the model has
to learn, and `depth`'s own default (`2`) already makes absence ambiguous.
