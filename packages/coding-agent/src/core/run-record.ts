/**
 * Run records: the durable counterpart of the in-memory retry state.
 *
 * A record marks the assistant message that ended a run and how the run ended, so a failure that
 * outlives the process (crash, disconnect, `kill`) can still be replayed from the session file.
 * Records are plain `custom` entries: they carry no model-visible content, so the projection,
 * compaction, and export paths treat them as bookkeeping.
 */

import type { AssistantMessage } from "@nanopi/pi-ai/compat";
import { type CustomEntry, type SessionEntry, sessionEntryToContextMessages } from "./session-manager.ts";

export const RUN_RECORD_CUSTOM_TYPE = "run";

/** How the recorded run ended. */
export type RunRecordOutcome = "completed" | "failed" | "aborted";

export interface RunRecordData {
	/** Start of the run's first message; `undefined` when the run produced no message entry. */
	firstEntryId?: string;
	/** The assistant message the run ended with. */
	lastEntryId?: string;
	stopReason: AssistantMessage["stopReason"];
	errorMessage?: string;
	/** Turn counter the run reached, for display only. */
	turns: number;
	outcome: RunRecordOutcome;
	/**
	 * Retry attempts the run already spent. Auto-retry rewrites the record after every attempt, so
	 * replaying a stored failure continues the same budget instead of starting a fresh one.
	 */
	attempts: number;
}

export function isRunRecord(entry: SessionEntry): entry is CustomEntry<RunRecordData> {
	return entry.type === "custom" && entry.customType === RUN_RECORD_CUSTOM_TYPE;
}

/** The record's payload, when `entry` is a run record with a readable payload. */
export function getRunRecordData(entry: SessionEntry): RunRecordData | undefined {
	if (!isRunRecord(entry)) return undefined;
	const data = entry.data;
	if (!data || typeof data !== "object") return undefined;
	return data;
}

/** The newest run record on the branch, if any. */
export function findLastRunRecord(branch: SessionEntry[]): CustomEntry<RunRecordData> | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (isRunRecord(entry)) return entry;
	}
	return undefined;
}

export type RunRecordTarget = Pick<CustomEntry<RunRecordData>, "id" | "timestamp">;

/** A failed response that a later request can replay. */
export interface RecoverableRun {
	/** The entry holding the failed assistant message. */
	lastEntryId: string;
	errorMessage: string;
	/** Retry attempts already spent, omitted from a replay request's budget. */
	attempts: number;
}

/**
 * The failed response the branch can replay, if the last run ended in one and nothing replaced it.
 *
 * Returns `undefined` when the branch has no run record, the record's outcome is not a failure, the
 * failure was already omitted from the model projection (by auto-retry or by a retry that ran), or
 * a later entry in the run supplied fresh input.
 */
export function findRecoverableRun(branch: SessionEntry[]): RecoverableRun | undefined {
	const record = findLastRunRecord(branch);
	if (!record) return undefined;
	const data = getRunRecordData(record);
	if (data?.outcome !== "failed" || !data.lastEntryId) return undefined;

	const index = branch.findIndex((entry) => entry.id === record.id);
	const failed = branch.find((entry) => entry.id === data.lastEntryId);
	if (!failed) return undefined;
	const failedIndex = branch.indexOf(failed);
	if (failedIndex < 0 || failedIndex > index) return undefined;

	return isReplayableFailure(failed, branch.slice(failedIndex + 1, index))
		? {
				lastEntryId: failed.id,
				errorMessage: data.errorMessage ?? "Unknown error",
				attempts: data.attempts,
			}
		: undefined;
}

/** How a retry reaches the model again. */
export type ReplayMode =
	/** Repeat the failed response: the projection still routes it as `failed`. */
	| "response"
	/** Repeat the request without it: the projection no longer holds the response. */
	| "turn";

/** A failure `/retry` can act on. */
export interface ReplayableFailure {
	/** The entry holding the failed assistant message. */
	lastEntryId: string;
	errorMessage: string;
	/** Retry attempts the failed run already spent. */
	attempts: number;
	replay: ReplayMode;
}

/**
 * The failure `/retry` would replay, in either of the two shapes a failed run leaves behind.
 *
 * A run that failed and stayed failed is {@link findRecoverableRun}'s case: the response is still
 * in the projection, so replaying it repeats the request that failed.
 *
 * Auto-retry that spent its budget leaves the opposite shape. Every attempt omits its response
 * from the projection, so {@link findRecoverableRun} finds nothing even though the run failed:
 * the omission that keeps the retried request clean is also what makes the failure unreplayable.
 * The run record of the final attempt still points at that response, so this returns it as a turn
 * replay instead of reporting that nothing failed.
 *
 * `lastRunAssistantEntryId` is the caller's own record of which response the newest run ended
 * with. When it disagrees with the run record, a later run has happened and the transcript moved
 * on, so there is nothing to retry.
 */
export function findReplayableFailure(
	branch: SessionEntry[],
	lastRunAssistantEntryId: string | undefined,
): ReplayableFailure | undefined {
	if (lastRunAssistantEntryId === undefined) return findResponseFailure(branch);

	const record = findLastRunRecord(branch);
	const data = record ? getRunRecordData(record) : undefined;
	if (!record || !data || data.outcome !== "failed") return findResponseFailure(branch);
	// The record names the failure when the branch could resolve it; the session names it otherwise.
	const lastEntryId = data.lastEntryId ?? lastRunAssistantEntryId;
	if (lastEntryId !== lastRunAssistantEntryId) return findResponseFailure(branch);

	const index = branch.findIndex((entry) => entry.id === record.id);
	const failed = branch.find((entry) => entry.id === lastRunAssistantEntryId);
	if (index < 0 || !failed) return undefined;
	const failedIndex = branch.indexOf(failed);
	if (failedIndex < 0 || failedIndex > index) return undefined;

	// The failure has to be the end of the conversation the next request is built from. Only its
	// own omission is expected; a message the model would see after it means the user moved on.
	for (const entry of branch.slice(failedIndex + 1, index)) {
		if (entry.type === "context_edit" && entry.targetId === failed.id) continue;
		if (sessionEntryToContextMessages(entry).length > 0) return undefined;
	}
	return {
		lastEntryId,
		errorMessage: data.errorMessage ?? "Unknown error",
		attempts: data.attempts,
		replay: "turn",
	};
}

/** {@link findRecoverableRun}, shaped as a replay mode. */
function findResponseFailure(branch: SessionEntry[]): ReplayableFailure | undefined {
	const recoverable = findRecoverableRun(branch);
	return recoverable ? { ...recoverable, replay: "response" } : undefined;
}

/**
 * Whether a failed assistant entry still reads as the end of the conversation in the projection the
 * next request is built from: its own raw messages survive, no context edit removes them, and the
 * run recorded nothing after it that the model would see.
 */
export function isReplayableFailure(failed: SessionEntry, after: SessionEntry[]): boolean {
	if (failed.type !== "message" || failed.message.role !== "assistant") return false;
	if (sessionEntryToContextMessages(failed).length === 0) return false;
	for (const entry of after) {
		if (entry.type === "context_edit" && entry.targetId === failed.id) return false;
		if (entry.type === "compaction") return false;
		if (sessionEntryToContextMessages(entry).length > 0) return false;
	}
	return true;
}
