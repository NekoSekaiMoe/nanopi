/**
 * Task-level regression net for prompt and tool-contract changes.
 *
 * Each task is a fixed workload: a seeded workspace, a scripted faux-provider turn sequence that
 * plays the model against the *real* tool declarations, and an assertion on what the tools did to
 * the disk. A prompt edit that removes a contract the model needs (unique `oldText`, "read before
 * you edit", continuation offsets, hidden declarations, append-only tool deltas) breaks a task here
 * instead of showing up as a silent completion-rate drop.
 *
 * The faux model is deterministic, so a failing task means a tool description, a system prompt
 * section, or the transcript replay changed; it never means the model had a bad day. What that does
 * not cover: nothing measures whether a real model still *obeys* a rewritten contract. Treat a green
 * run as "the contract still ships", not as "the model still follows it".
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AssistantMessage } from "@nanopi/pi-ai";
import type { TranscriptContext } from "@nanopi/pi-ai/compat";
import type { ModuleApi } from "../../../src/core/modules/types.ts";
import type { CreateTestModulesResultInput } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

export interface TaskRecord {
	/** One entry per provider request, with the transcript the provider actually received. */
	requests: TranscriptContext[];
	/** One entry per finished tool call: name, arguments, error flag, and result text. */
	toolCalls: ToolResultRecord[];
}

export interface ToolResultRecord {
	toolName: string;
	args: Record<string, unknown>;
	isError: boolean;
	text: string;
}

/** Writes a file inside the task workspace, creating parents. */
export function seedFile(harness: Harness, path: string, content: string): void {
	const absolute = join(harness.tempDir, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content);
}

/** Reads a file from the task workspace. Throws when an edit deleted it. */
export function readWorkspaceFile(harness: Harness, path: string): string {
	return readFileSync(join(harness.tempDir, path), "utf-8");
}

/** Registers the recording module every task needs. */
export function createTaskRecorder(): { module: CreateTestModulesResultInput; record: TaskRecord } {
	const record: TaskRecord = { requests: [], toolCalls: [] };
	const factory = (nanopi: ModuleApi) => {
		nanopi.on("tool_result", (event) => {
			record.toolCalls.push({
				toolName: event.toolName,
				args: event.input,
				isError: event.isError,
				text: event.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n"),
			});
		});
	};
	return { module: { name: "task-recorder", factory }, record };
}

/**
 * Responses are callbacks so each request's transcript is captured before the model "answers".
 * A callback that throws would be swallowed by the faux provider, so nothing here asserts.
 */
export function recordRequests(record: TaskRecord, steps: AssistantMessage[]) {
	return steps.map((step) => (context: TranscriptContext) => {
		record.requests.push(context);
		return step;
	});
}

export function toolCallsOf(record: TaskRecord, toolName?: string): ToolResultRecord[] {
	return toolName === undefined ? record.toolCalls : record.toolCalls.filter((call) => call.toolName === toolName);
}

export function failedCalls(record: TaskRecord): ToolResultRecord[] {
	return record.toolCalls.filter((call) => call.isError);
}

/** A harness with the task recorder already loaded; clean it up in the enclosing `finally`. */
export async function createTaskHarness(
	options: Parameters<typeof createHarness>[0] = {},
): Promise<{ harness: Harness; record: TaskRecord }> {
	const recorder = createTaskRecorder();
	const harness = await createHarness({ ...options, modules: [...(options.modules ?? []), recorder.module] });
	return { harness, record: recorder.record };
}
