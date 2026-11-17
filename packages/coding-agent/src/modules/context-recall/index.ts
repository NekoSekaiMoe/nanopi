/**
 * Built-in context recall.
 *
 * Compaction replaces the conversation with a summary, and the exact text behind it (the
 * failure, the path, the decision) leaves the context for good. The summary prompt therefore
 * asks for `[rN]` citations, and this module gives the model a way to read one back.
 *
 * `recall_context` resolves the tags against the newest summary's `<refs>` block and appends a
 * `context_recall` entry, which the projection replays into the conversation. The recalled
 * text therefore survives the next compaction the way any other message does, instead of
 * living in a tool result that the next summary eats.
 */

import type { ModuleEventsSurface, ModuleToolsSurface } from "../../core/modules/types.ts";
import { registerRecallTool } from "./tool.ts";

export default function contextRecallExtension(pi: ModuleEventsSurface & ModuleToolsSurface): void {
	registerRecallTool(pi);
}
