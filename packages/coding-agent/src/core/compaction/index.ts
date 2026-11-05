/**
 * Compaction and summarization utilities.
 *
 * Explicit re-exports on purpose: `export *` here made every consumer of this barrel drag the
 * whole compaction implementation, so a single type import reached 181 files. Listing the names
 * keeps the barrel honest about what it offers, and `scripts/check-entry-graphs.mjs` holds the
 * cost of each entry point that goes through it.
 */

export type {
	BranchPreparation,
	BranchSummaryDetails,
	BranchSummaryResult,
	CollectEntriesResult,
	GenerateBranchSummaryOptions,
} from "./branch-summarization.ts";
export {
	collectEntriesForBranchSummary,
	generateBranchSummary,
	prepareBranchEntries,
} from "./branch-summarization.ts";
// Types: cheap for anyone who only needs the shapes.
export type {
	CompactionDetails,
	CompactionPreparation,
	CompactionResult,
	CompactionSettings,
	ContextUsageEstimate,
	CutPointResult,
	InContextCompactionCosts,
	InContextCompactionDecision,
	InContextCompactionInput,
	InContextCompactionOutcome,
} from "./compaction.ts";

// Implementation.
export {
	appendInContextCompactionRequest,
	calculateContextTokens,
	compact,
	compactInContext,
	completeSummarization,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateProjectedContextTokens,
	estimateTokens,
	evaluateInContextCompaction,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	generateSummaryWithUsage,
	getInContextCompactionOutcome,
	getLastAssistantUsage,
	IN_CONTEXT_COMPACTION_INSTRUCTIONS,
	IN_CONTEXT_COMPACTION_PROMPT,
	InContextCompactionError,
	isCutPointMessage,
	isTurnStartMessage,
	prepareCompaction,
	shouldCompact,
	supportsInContextCompaction,
} from "./compaction.ts";
export type { FileOperations } from "./utils.ts";
export {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";
