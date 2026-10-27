# Agent Note: Rename and delete are one tool, and neither writes by default

Status: implemented

## Problem

`lsp_rename` and `lsp_delete` sat next to each other with identical position
parameters and an identical lifecycle: resolve a cursor, compute a
workspace-wide change, drop the files outside the project root, optionally write,
then re-open the touched files on the server and report what the rescan says.
The two handlers shared that whole spine — the outside-project filter was
copy-pasted, the rescan parameters were the same, and `executionMode:
"sequential"` was set twice — and the only thing keeping them consistent was a
comment.

They disagreed on the one field that matters. `rename` defaulted `apply` to
`true`; `delete` defaulted it to `false`. So the same tool family answered "did
you mean to write that?" twice, in opposite ways, and a model that learned the
dry-run habit from `delete` would still rename on the first call.

## Decision

One tool, one discriminator:

```
lsp_edit { path, line, character,
           kind: "rename" | "delete",
           newName?,        // required for kind=rename
           apply?,          // default false
           timeoutMs }
```

- `apply` defaults to `false` for **both** kinds. A rename is a workspace-wide
  multi-file write that a tool message cannot undo; requiring the model to ask
  for it explicitly costs one extra call and removes a class of accident.
  `kind=rename` without `newName` is answered with that sentence instead of a
  guess, before any server is contacted.
- The two branches are extracted into `renameSymbol` / `deleteSymbol`; the tool
  definition is a router. The shared pieces (position resolution, `perCall`
  budget, `rescan`, `dryRunHint`) are now used from one place rather than
  duplicated by convention.
- The dry-run output keeps the full plan — files and edit counts for a rename,
  declaration/usage line ranges and the manual-cleanup list for a delete — so
  the preview is what the model decides from, not a summary of it.

## Consequences

| | before | after |
| --- | --- | --- |
| tools | 6 | 5 |
| schema characters | 3050 | 2789 |
| text characters | 714 | 581 |
| guidance characters | 2162 | 1660 |
| prompt tokens | ~940 | ~840 |

- **Breaking for behavior, not just naming.** A session that called
  `lsp_rename` and relied on it writing now gets a preview. That is the intended
  direction of the change, and it is called out in the CHANGELOG's Breaking
  Changes section rather than buried under Removed.
- The `kind` discriminant is required (not defaulted) because there is no
  obvious default: `delete` destroys code, `rename` does not, and picking either
  one for an omitted field is a guess about intent.
- Field exclusivity (`newName` only meaningful for `rename`) is enforced in the
  handler with one sentence instead of a schema union. A union would express it
  in the schema at the cost of a larger serialized form and a worse error
  message.
- 5 tools and ~740 tokens is the floor for this shape: `hover`, `definition`,
  `diagnostics` stay separate because their return shapes and server paths
  differ, and folding them in would make one tool whose description covers five
  unrelated answers.

## Alternatives considered

**Keep two tools and only unify the `apply` default.** No discriminated union, no
missing-`newName` check, and every prompt keeps the discoverability of a tool
literally named `delete`. Rejected because the duplication being removed is the
*shared lifecycle*: two handlers writing to the same files needed the same
outside-project filter and the same post-change rescan, and the existing code
already had that logic twice.

**Merge into `lsp_query` as more `kind` values (`rename`/`delete` alongside
`references`/`callgraph`).** One tool for every LSP request. Rejected: `query` is
read-only. Mixing a destructive workspace write into it would mean a tool whose
description has to warn about two of its four branches, and whose
`executionMode` is "sequential" for reasons the read branches do not share.

**Keep `apply` defaulting to `true` for rename, `false` for delete, keyed on
`kind`.** Preserves today's behavior exactly. Rejected: two defaults in one
schema is precisely the ambiguity the merge was meant to delete, and
`apply?: boolean` whose default depends on a sibling field is a rule the model
(and the next reader) has to memorize.

**Express `newName`/`newText` as a `Type.Union` of two objects so the schema
enforces the pairing.** Rejected: the effective serialized schema grows more
than the sentence it replaces, and a union failure message ("no branch matched")
is worse than `kind=rename needs newName`.
