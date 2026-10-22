import { describe, expect, test } from "vitest";
import { planSnapshotOf } from "../src/modes/webui/webui-server.ts";

// The webui used to send only the todo tool's text output, so its plan was in
// the model's context but nowhere on screen (issue #152). The snapshot rides on
// the tool_result event instead; these cases pin the wire shape.

describe("planSnapshotOf", () => {
	test("mirrors the todo details", () => {
		expect(
			planSnapshotOf("todo", {
				action: "add",
				todos: [
					{ id: 1, text: "read the code", status: "in_progress" },
					{ id: 2, text: "run the tests", status: "pending", isVerification: true },
				],
			}),
		).toEqual({
			plan: [
				{ id: 1, text: "read the code", status: "in_progress" },
				{ id: 2, text: "run the tests", status: "pending", isVerification: true },
			],
		});
	});

	test("sends an empty plan for a cleared list", () => {
		// `clear` must reach the browser as an empty snapshot, otherwise the
		// rendered plan survives a plan the model already dropped.
		expect(planSnapshotOf("todo", { action: "clear", todos: [] })).toEqual({ plan: [] });
	});

	test("stays silent for other tools and malformed rows", () => {
		expect(planSnapshotOf("bash", { todos: [{ id: 1, text: "x", status: "pending" }] })).toEqual({});
		expect(planSnapshotOf("todo", undefined)).toEqual({});
		expect(planSnapshotOf("todo", { todos: "nope" })).toEqual({});
		expect(
			planSnapshotOf("todo", {
				todos: [
					{ id: "1", text: "bad id", status: "pending" },
					{ id: 2, text: "bad status", status: "doing" },
					{ id: 3, status: "pending" },
					{ id: 4, text: "kept", status: "completed" },
				],
			}),
		).toEqual({ plan: [{ id: 4, text: "kept", status: "completed" }] });
	});
});
