/**
 * Tasks that depend on project context reaching the model.
 *
 * An AGENTS.md-style file is the only per-project prompt input, and it is loaded by a module, so
 * it flows through the same section diff as everything else. These tasks make sure the text lands
 * in the request the model sees (not just in the loader), and that it survives the next turn.
 */

import { fauxAssistantMessage, fauxToolCall } from "@nanopi/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleApi } from "../../../src/core/modules/types.ts";
import type { createHarness, Harness } from "../harness.ts";
import { createTaskHarness, readWorkspaceFile, recordRequests, type TaskRecord } from "./task-network.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function promptTwice(
	options: Parameters<typeof createHarness>[0],
): Promise<{ harness: Harness; record: TaskRecord }> {
	const { harness, record } = await createTaskHarness(options);
	harnesses.push(harness);
	harness.setResponses(recordRequests(record, [fauxAssistantMessage("one"), fauxAssistantMessage("two")]));
	await harness.session.prompt("one");
	await harness.session.prompt("two");
	return { harness, record };
}

describe("task network: project context", () => {
	it("puts the context file in the request and keeps it across turns", async () => {
		const { harness, record } = await promptTwice({
			appendSystemPrompt: ["Appended by the user."],
			contextFiles: [{ path: "/project/AGENTS.md", content: "Always use tabs for indentation." }],
		});

		const first = record.requests[0]?.messages[0];
		if (first?.role !== "system") throw new Error("expected a leading system message");
		expect(first.sections?.project_context).toContain("Always use tabs for indentation.");
		expect(first.sections?.project_context).toContain("/project/AGENTS.md");
		expect(first.sections?.addendum).toContain("Appended by the user.");
		expect(harness.session.systemPrompt).toContain("Always use tabs for indentation.");

		// The second request reuses the same head, so the context is not re-sent.
		expect(record.requests[1]?.messages[0]).toEqual(first);
	});

	it("lets the model follow an instruction that only exists in the context file", async () => {
		const { harness, record } = await createTaskHarness({
			contextFiles: [{ path: "/project/AGENTS.md", content: "All files live under src/." }],
		});
		harnesses.push(harness);
		harness.setResponses(
			recordRequests(record, [
				fauxAssistantMessage([fauxToolCall("write", { path: "src/out.txt", content: "ok\n" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Wrote src/out.txt."),
			]),
		);
		await harness.session.prompt("Write out.txt.");

		expect(readWorkspaceFile(harness, "src/out.txt")).toBe("ok\n");
		const first = record.requests[0]?.messages[0];
		if (first?.role !== "system") throw new Error("expected a leading system message");
		expect(first.sections?.project_context).toContain("All files live under src/.");
	});

	it("adds and removes sections without restating the prompt", async () => {
		let turn = 0;
		const toggleSections = (nanopi: ModuleApi): void => {
			nanopi.on("before_agent_start", (event) => {
				turn += 1;
				if (turn === 2) event.systemPromptOptions.sections.plan_mode = "Plan only, do not edit.";
				if (turn === 3) delete event.systemPromptOptions.sections.plan_mode;
			});
		};
		const { harness, record } = await createTaskHarness({
			modules: [{ name: "toggle-sections", factory: toggleSections }],
		});
		harnesses.push(harness);
		harness.setResponses(
			recordRequests(record, [
				fauxAssistantMessage("one"),
				fauxAssistantMessage("two"),
				fauxAssistantMessage("three"),
			]),
		);
		for (const text of ["one", "two", "three"]) await harness.session.prompt(text);

		const patches = record.requests.map((request) =>
			request.messages.filter((message) => message.role === "system").at(-1),
		);
		const second = patches[1];
		if (second?.role !== "system") throw new Error("expected a system patch");
		expect(second.sections?.plan_mode).toContain("Plan only, do not edit.");
		const third = patches[2];
		if (third?.role !== "system") throw new Error("expected a system patch");
		// A removed section is sent as null, not as an empty string, so the model can tell them apart.
		expect(third.sections?.plan_mode).toBeNull();
		expect(harness.session.systemPrompt).not.toContain("Plan only, do not edit.");
	});
});
