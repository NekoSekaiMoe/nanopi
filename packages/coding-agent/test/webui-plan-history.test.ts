import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, ToolResultMessage } from "@nanopi/pi-ai";
import { describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { planFromSessionEntries, readSessionMessages } from "../src/modes/webui/webui-server.ts";

// Issue #152: the webui showed the plan only from the live `tool_result` event,
// so a session reloaded from disk stayed plan-less until the model called
// `todo` again. The plan is a tool detail the transcript messages do not carry,
// so the backend now derives it from the log; these cases pin that derivation
// against the ways a log can differ from "the last todo result in the file".

/** One `todo` tool result as the extension records it. */
function todoResult(callId: string, todos: unknown[], isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "todo",
		content: [{ type: "text", text: "ok" }],
		details: { action: "add", todos, nextId: todos.length + 1 },
		isError,
		timestamp: Date.now(),
	} as ToolResultMessage;
}

function assistantCall(callId: string): Message {
	return {
		role: "assistant",
		provider: "faux",
		model: "alpha",
		content: [{ type: "toolCall", id: callId, name: "todo", arguments: { action: "add" } }],
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as unknown as Message;
}

function userMessage(text: string): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/**
 * Write a session through a real SessionManager, then read it back as a file.
 * The starting user message matters: a session with no user or assistant
 * message never reaches disk (SessionManager._hasConversation).
 */
async function logged(build: (manager: SessionManager) => void): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "nanopi-webui-plan-"));
	const manager = SessionManager.create(root, join(root, "sessions"));
	manager.appendMessage(userMessage("start"));
	build(manager);
	const file = manager.getSessionFile();
	if (!file) throw new Error("the session did not record a file");
	return readFile(file, "utf8");
}

describe("planFromSessionEntries", () => {
	test("reports the plan of the last todo result", async () => {
		const content = await logged((manager) => {
			manager.appendMessage(assistantCall("call-1"));
			manager.appendMessage(
				todoResult("call-1", [
					{ id: 1, text: "read the code", status: "in_progress" },
					{ id: 2, text: "run the tests", status: "pending", isVerification: true },
				]),
			);
			manager.appendMessage(assistantCall("call-2"));
			manager.appendMessage(
				todoResult("call-2", [
					{ id: 1, text: "read the code", status: "completed" },
					{ id: 2, text: "run the tests", status: "in_progress", isVerification: true },
				]),
			);
		});

		expect(readSessionMessages(content).plan).toEqual([
			{ id: 1, text: "read the code", status: "completed" },
			{ id: 2, text: "run the tests", status: "in_progress", isVerification: true },
		]);
	});

	test("keeps an empty plan after a clear", async () => {
		const content = await logged((manager) => {
			manager.appendMessage(assistantCall("call-1"));
			manager.appendMessage(todoResult("call-1", [{ id: 1, text: "x", status: "pending" }]));
			manager.appendMessage(assistantCall("call-2"));
			manager.appendMessage(todoResult("call-2", []));
		});

		// An empty list is a plan the model dropped, and the card has to go with
		// it; only a result with no plan shape at all falls back to an older call.
		expect(readSessionMessages(content).plan).toEqual([]);
	});

	test("stays quiet for a session without a todo plan", async () => {
		const content = await logged((manager) => {
			manager.appendMessage(assistantCall("call-1"));
			manager.appendMessage({
				...todoResult("call-1", []),
				toolName: "bash",
				details: { stdout: "hi" },
			} as ToolResultMessage);
		});

		expect(readSessionMessages(content).plan).toBeUndefined();
		expect(planFromSessionEntries([])).toBeUndefined();
	});

	test("drops rows it cannot read instead of the whole plan", async () => {
		const content = await logged((manager) => {
			manager.appendMessage(assistantCall("call-1"));
			manager.appendMessage(
				todoResult("call-1", [
					{ id: 1, text: "kept", status: "completed" },
					{ id: "2", text: "bad id", status: "pending" },
					{ id: 3, text: "bad status", status: "doing" },
				]),
			);
		});

		expect(readSessionMessages(content).plan).toEqual([{ id: 1, text: "kept", status: "completed" }]);
	});

	test("follows the branch, not the file order", async () => {
		// A branch rewrote the plan and was abandoned. The file keeps both the
		// abandoned entries and the ones on the live branch, so reading the last
		// todo line in the file would report a plan the agent never had.
		const content = await logged((manager) => {
			manager.appendMessage(assistantCall("call-1"));
			const keep = manager.appendMessage(todoResult("call-1", [{ id: 1, text: "kept", status: "pending" }]));
			manager.appendMessage(todoResult("call-2", [{ id: 1, text: "abandoned", status: "pending" }]));
			manager.branch(keep);
			manager.appendMessage(todoResult("call-3", [{ id: 1, text: "kept", status: "completed" }]));
		});

		expect(readSessionMessages(content).plan).toEqual([{ id: 1, text: "kept", status: "completed" }]);
	});

	test("honours a context edit that replaced the todo result", async () => {
		// An edit replaces the message content but leaves the tool details alone,
		// so the log still holds a plan the model no longer sees; the plan of the
		// call before the edit stands.
		const content = await logged((manager) => {
			manager.appendMessage(assistantCall("call-1"));
			manager.appendMessage(todoResult("call-1", [{ id: 1, text: "first", status: "in_progress" }]));
			const second = manager.appendMessage(todoResult("call-2", [{ id: 1, text: "first", status: "completed" }]));
			manager.appendContextEdit(second, { content: [{ type: "text", text: "(removed)" }] });
		});

		expect(readSessionMessages(content).plan).toEqual([{ id: 1, text: "first", status: "in_progress" }]);
	});

	test("falls back past a todo result that carried no plan", async () => {
		// A failed todo call records the error text and no details, so the newest
		// plan on the branch is still the earlier one.
		const content = await logged((manager) => {
			manager.appendMessage(assistantCall("call-1"));
			manager.appendMessage(todoResult("call-1", [{ id: 1, text: "a", status: "completed" }]));
			manager.appendMessage(assistantCall("call-2"));
			const failed = todoResult("call-2", [], true);
			delete (failed as { details?: unknown }).details;
			manager.appendMessage(failed);
		});

		expect(readSessionMessages(content).plan).toEqual([{ id: 1, text: "a", status: "completed" }]);
	});

	test("reports no plan when the only todo result was edited away", async () => {
		const content = await logged((manager) => {
			manager.appendMessage(assistantCall("call-1"));
			const only = manager.appendMessage(todoResult("call-1", [{ id: 1, text: "x", status: "pending" }]));
			manager.appendContextEdit(only, null);
		});

		expect(readSessionMessages(content).plan).toBeUndefined();
	});
});
