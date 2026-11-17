# Agent Note: externalize truncated tool results

Status: implemented

## Problem

A single oversized `read`, `grep`, `find`, or `ls` result was cut to a preview and the rest was thrown away. Bash already had a temp-file escape hatch, but the file tools only told the model to narrow the query; once the session had moved on, the omitted bytes were unrecoverable. The billion-context work identified this as the local, high-value counterpart to whole-session compaction: keep the LLM context small without discarding the evidence.

## Decision

Truncated text results from `read`, `grep`, `find`, and `ls` are written to a private file in the agent dir and the tool result carries a stable `toolResultRef` plus a path. A new `tool_result_store` module registers the `recall_tool_result` tool, which reads a stored result back in bounded pages by ref. The ref and path are also in the notice appended to the preview, so a model that does not know about the tool still sees where the bytes went.

Storage is per agent dir (`<agentDir>/tool-results/<ref>.txt`), created with mode 0600, and refs are random hex. The recall tool refuses absolute paths and any path outside the store, and caps a read at 50 KB so recalling cannot put the original payload back into context in one call. The store owns raw bytes; compaction and export keep operating on the preview already in the transcript.

## Alternatives considered

- **Full SQLite block ledger with per-message refs and decompress/search tools.** That is billion-context's kernel, and it conflicts with nanopi's append-only jsonl sessions. The incremental gain over one file per truncated result did not justify a schema.
- **Only extend `read` with offset/limit and tell the model to re-run the search.** Already possible for `read`; useless for a grep that matched a file nobody knows the name of, and it discards the exact bytes the first call produced.
- **Keep the full result in `details` / `structuredContent`.** Those fields travel in the model request for tools that declare them, so the context saving disappears. They may also be replayed to providers that do not use them, which defeats the purpose.

## Consequences

- Every truncated file-tool result creates one file that lives until the user cleans the agent dir. No GC is added: a ref is cheap and deleting a file an old session might still recall would be worse.
- The LLM sees a short notice and a ref, not the whole result. To inspect omitted matches it must call `recall_tool_result`, which costs another turn but returns pages instead of the original flood.
- `bash` keeps its existing temp-file path and `fullOutputPath` contract. Changing it would touch the structured output shape and every renderer that knows about it for no added benefit.

## Testing

`packages/coding-agent/test/tool-result-store.test.ts` checks the store's path confinement and paging, and the grep/find/ls/read notices with a real truncated result.
