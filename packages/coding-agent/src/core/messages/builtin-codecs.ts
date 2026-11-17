/**
 * Codecs for the message kinds this app writes itself: `bashExecution`,
 * `branchSummary`, `compactionSummary`, and `recalledContext`.
 *
 * They are built in because the app produces them: bash executions come from the shell
 * tool, the summaries from compaction and branch navigation. A module that adds its own
 * kind registers a codec through `registerMessageType()`; nothing here needs to know
 * about it.
 */

import type { AgentMessage } from "@nanopi/pi-agent-core";
import { countTextTokens, countTokenFragments } from "@nanopi/pi-ai/utils/text";
import {
	type BashExecutionMessage,
	BRANCH_SUMMARY_PREFIX,
	BRANCH_SUMMARY_SUFFIX,
	type BranchSummaryMessage,
	bashExecutionToText,
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	type CompactionSummaryMessage,
	RECALLED_CONTEXT_PREFIX,
	RECALLED_CONTEXT_SUFFIX,
	type RecalledContextMessage,
} from "../messages.ts";
import { renderBranchSummary, renderCompactionSummary } from "./builtin-renderers.ts";
import type { MessageTypeCodec, MessageTypeCodecMap } from "./codec.ts";

/** Legacy chars/4 fallback for callers that already hold only a character count. */
export function charsToTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

const bashExecution: MessageTypeCodec<BashExecutionMessage> = {
	kind: "bashExecution",
	toLlm(message) {
		// `${command}!!` runs without contributing to the conversation.
		if (message.excludeFromContext) return [];
		return [
			{
				role: "user",
				content: [{ type: "text", text: bashExecutionToText(message) }],
				timestamp: message.timestamp,
			},
		];
	},
	estimateTokens: (message) => countTokenFragments([message.command, message.output]),
};

const branchSummary: MessageTypeCodec<BranchSummaryMessage> = {
	kind: "branchSummary",
	toLlm: (message) => [
		{
			role: "user",
			content: [{ type: "text", text: BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX }],
			timestamp: message.timestamp,
		},
	],
	estimateTokens: (message) => countTextTokens(message.summary),
	renderRun: renderBranchSummary,
};

const compactionSummary: MessageTypeCodec<CompactionSummaryMessage> = {
	kind: "compactionSummary",
	toLlm: (message) => [
		{
			role: "user",
			content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX }],
			timestamp: message.timestamp,
		},
	],
	estimateTokens: (message) => countTextTokens(message.summary),
	renderRun: renderCompactionSummary,
};

const recalledContext: MessageTypeCodec<RecalledContextMessage> = {
	kind: "recalledContext",
	toLlm: (message) => [
		{
			role: "user",
			content: [{ type: "text", text: RECALLED_CONTEXT_PREFIX + message.content + RECALLED_CONTEXT_SUFFIX }],
			timestamp: message.timestamp,
		},
	],
	estimateTokens: (message) => countTextTokens(message.content),
};

export function createBuiltinMessageCodecs(): MessageTypeCodecMap {
	const codecs = [bashExecution, branchSummary, compactionSummary, recalledContext] as MessageTypeCodec[];
	return new Map(codecs.map((codec) => [codec.kind, codec]));
}

/** Token estimate for one message, or 0 for a kind nobody registered. */
export function estimateMessageTokens(codecs: MessageTypeCodecMap, message: AgentMessage): number {
	const kind = (message as { role?: string }).role;
	const codec = kind ? (codecs.get(kind) as MessageTypeCodec<AgentMessage> | undefined) : undefined;
	return codec ? (codec.estimateTokens?.(message) ?? 0) : 0;
}
