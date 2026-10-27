# Agent Note: `rename_file` waits until the LSP-side move can be transactional

Status: rejected — the file move itself is cheap, but keeping the language server's view, the disk, and the tool result consistent is not, and a half-applied rename is worse than no tool.

## Problem

Moving a file looks like the cheap half of an LSP integration: `mv old.ts new.ts`
plus, on servers that support it, `workspace/willRenameFiles` — the server answers
with a `WorkspaceEdit` of the import updates the move implies, and the caller
applies it. Tools that ship it present it as one action among many; the reference
implementation behind oh-my-pi has it in a 14-action `lsp` tool.

The reason it is attractive here is the same reason `lsp_hover` and
`lsp_definition` were worth building (see
[the hover/definition note](../../implemented/feature/2026-10-27-lsp-hover-definition-and-read-diagnostics.md)):
a rename that only moves the file forces the model to find every importer itself,
one grep and one `edit` at a time, and each of those is a turn.

What separates it from hover is what happens when the operation only *half*
works.

## Proposal

The shape a `rename_file` tool would have:

1. `fs.rename` the file, creating the destination directory if needed.
2. Send `workspace/didRenameFiles` (and `workspace/willRenameFiles` before step 1)
   so the server re-indexes and can compute import updates.
3. Apply the returned `WorkspaceEdit` through the existing `applyTextEdits` /
   `normalizeWorkspaceEdit` path that `lsp_rename` already uses.
4. Re-scan diagnostics for every touched file, exactly as `lsp_rename` does.

## Alternatives considered

**Apply the edit first, move second.** Least surprising on disk — a failed edit
leaves the file where it was. But `willRenameFiles` describes the *old* URI; a
server that already saw the move refuses the request, and the edits it returns
reference paths that the second half of the operation then invalidates.

**Move first, edit second (the proposal).** The state after step 1 is a moved file
whose importers are broken, and every step after it can fail: no server matches
the extension, the server has no `willRenameFiles`, it returns edits outside the
project, the disk write hits a permission error, the edit conflicts with a change
made between the rename and the apply. The recovery story for each is different
and the model has to be told which one it is in.

**Move only, leave the imports to the model.** Honest and small: the model gets
`file:line` diagnostics for every broken import and fixes them with `edit`. This
is genuinely the cheaper option, and it is the one that follows from the current
architecture — but it does not save the turns the tool is supposed to save, so it
is not worth a tool of its own.

**Reference-tracking through `documentChanges`.** LSP's `WorkspaceEdit` already
carries `RenameFile` / `CreateFile` / `DeleteFile` operations, so a server that
supports it can express the whole move. The current `normalizeWorkspaceEdit`
skips those operations (`skipped: unsupported ops`), so this would mean teaching
the apply path a second kind of operation and then reconciling it with the
`fs.rename` this side would also be doing.

**A naive `fs.rename` plus a re-scan, ignoring `willRenameFiles`.** What most
users would write by hand, and it is what makes the case for the tool weak: the
value is the semantics, not the `mv`.

## Acceptance criteria

- The tool is transactional in the only sense that matters to a model: after it
  returns, either the file moved and every importer was updated, or nothing
  changed on disk. A rollback path exists and is exercised by a test, including
  the case where the server answers `willRenameFiles` and the apply then fails.
- Servers without `willRenameFiles` are handled by a documented outcome (move
  only, report the broken imports), not by an error.
- `normalizeWorkspaceEdit` handles `RenameFile` / `CreateFile` / `DeleteFile`, or
  the tool refuses a `WorkspaceEdit` that contains them instead of silently
  dropping the operations.
- The prompt budget does not grow more than the schemas it replaces: one tool,
  three parameters (`path`, `newName`, `apply`).

## Risks

- A move that succeeds on disk and fails on the edit is the worst outcome: the
  model is told "renamed" while the project no longer compiles, and it needs to
  read every importer to find out. Without a rollback the tool is a foot-gun.
- Two servers can match the same file. `lsp_rename` already picks the first match;
  for a move, applying the second server's edit on top of the first's is silent
  cross-server data loss.
- A `.git`-less or symlinked tree makes "the same file" ambiguous, and an LSP
  server that watches the old URI keeps publishing diagnostics for a path that
  no longer exists.
- The tool is used rarely compared to hover or diagnostics, so the maintenance
  surface it adds is paid for by almost no traffic.

## Why this is not the next step

The delivered follow-ups were `lsp_hover` / `lsp_definition` (which remove a file
read per signature) and read-time diagnostics (which removes a round per broken
file). Both are additive and stateless: they answer, they never mutate. A file
move is the first LSP operation whose failure modes are *stateful* on disk, and
the honest sequencing is to ship the read-only requests, see whether the model
reaches for `lsp_rename` at all, and only then decide whether the move is worth a
rollback path.
