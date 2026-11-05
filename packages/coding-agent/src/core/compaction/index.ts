/**
 * Compaction and summarization utilities.
 *
 * `export *` on purpose. A hand-written whitelist here silently dropped `getSummarizationFailure`
 * and nothing failed: only `compaction.ts` and `branch-summarization.ts` import it, and they import
 * the source file, so no test ever reached the barrel. A list can only be as complete as its last
 * audit; `export *` follows the source files by construction.
 *
 * The cost of this barrel is held by `scripts/check-entry-graphs.mjs` (19 files, budget 20) instead
 * of by the shape of the re-export line.
 */

export * from "./branch-summarization.ts";
export * from "./compaction.ts";
export * from "./utils.ts";
