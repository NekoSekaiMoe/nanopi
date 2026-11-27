/**
 * Context recall: a compaction summary cites the entries it compressed as `[rN]` tags, and
 * `resolveRecalledEntries()` reads those tags back from the newest summary. The tool that calls
 * this resolver is registered by the `context-recall-coordinator` module, which owns the single
 * `recall_context` tool name shared by all recall strategies.
 */

export type { RecalledEntry, ResolveResult } from "./resolve.ts";
export { resolveRecalledEntries } from "./resolve.ts";
