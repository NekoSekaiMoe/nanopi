/**
 * Tasks that pin the prompt surface a provider request is built from.
 *
 * The system prompt is not one string: it is the preamble, the declared tool list, the rules those
 * tools contribute, and whatever a module hid from the request. A prompt change is only safe if a
 * request keeps carrying exactly those parts. These tasks read the request the provider received,
 * not the session accessor, so a divergence between the two shows up here.
 */

import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getSystemMessageText } from "@nanopi/pi-ai";
import type { TranscriptContext } from "@nanopi/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleApi } from "../../../src/core/modules/types.ts";
import { createHarness, type Harness } from "../harness.ts";
import { recordRequests, type TaskRecord } from "./task-network.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function fileEditModule(nanopi: ModuleApi): void {
	nanopi.registerTool({
		name: "file_edit",
		label: "file_edit",
		description: "Edit a file.",
		promptSnippet: "Edit a file with targeted replacements",
		promptGuidelines: ["Use file_edit for every change; oldText must match uniquely"],
		prepareLoadout(loadout) {
			return loadout.declared.some((tool) => tool.name === "edit") ? { hiddenDeclarations: ["edit"] } : undefined;
		},
		parameters: { type: "object", properties: {}, additionalProperties: false } as never,
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	});
}

async function twoTurnRequestContexts(options: Parameters<typeof createHarness>[0]): Promise<{
	harness: Harness;
	requests: TranscriptContext[];
}> {
	const harness = await createHarness(options);
	harnesses.push(harness);
	const record: TaskRecord = { requests: [], toolCalls: [] };
	harness.setResponses(recordRequests(record, [fauxAssistantMessage("one"), fauxAssistantMessage("two")]));
	await harness.session.prompt("one");
	await harness.session.prompt("two");
	return { harness, requests: record.requests };
}

describe("task network: prompt surface of a request", () => {
	it("carries the preamble, tool list, rules and cwd the session reports", async () => {
		const { harness, requests } = await twoTurnRequestContexts({});

		const head = requests[0]?.messages.find((message) => message.role === "system");
		if (head?.role !== "system") throw new Error("expected a leading system message");
		expect(Object.keys(head.sections ?? {})).toEqual(["preamble", "tools", "rules", "docs", "cwd"]);
		expect(getSystemMessageText(head)).toBe(harness.session.systemPrompt);
		expect(getCurrentSystemPrompt(requests[0]!.messages)).toBe(harness.session.systemPrompt);

		const toolList = head.sections?.tools ?? "";
		for (const name of harness.session.getActiveToolNames()) expect(toolList).toContain(`- ${name}:`);
		expect(head.sections?.cwd).toContain(harness.tempDir.replace(/\\/g, "/"));
	});

	it("keeps the request payload minimal so a prompt diff stays cheap", async () => {
		const { requests } = await twoTurnRequestContexts({});

		// One system message in both requests: the second reuses the head declared by the first.
		const systemCounts = requests.map(
			(request) => request.messages.filter((message) => message.role === "system").length,
		);
		expect(systemCounts).toEqual([1, 1]);
		// The head is declared once; no later turn restates the unchanged sections.
		expect(requests[1]?.messages[0]).toEqual(requests[0]?.messages[0]);
	});

	it("shows the model the tool descriptions the tools ship", async () => {
		const { harness, requests } = await twoTurnRequestContexts({});
		const head = requests[0]?.messages[0];
		if (head?.role !== "system") throw new Error("expected a leading system message");

		const declared = new Map((head.toolsAdded ?? []).map((tool) => [tool.name, tool]));
		expect([...declared.keys()]).toEqual(harness.session.getActiveToolNames());
		const description = declared.get("edit")?.description ?? "";
		// The usage contract lives in the declaration, not in a separate prompt paragraph.
		expect(description.length).toBeGreaterThan(0);
		const parameters = declared.get("edit")?.parameters as { properties?: Record<string, unknown> } | undefined;
		expect(Object.keys(parameters?.properties ?? {})).toEqual(["path", "edits"]);
	});

	it("hides a declaration without dropping the tool from the session", async () => {
		const { harness, requests } = await twoTurnRequestContexts({
			modules: [{ name: "file-edit", factory: fileEditModule }],
			initialActiveToolNames: ["read", "bash", "edit", "write", "file_edit"],
		});

		expect(harness.session.getActiveToolNames()).toContain("edit");
		const head = requests[0]?.messages[0];
		if (head?.role !== "system") throw new Error("expected a leading system message");
		const declaredNames = (head.toolsAdded ?? []).map((tool) => tool.name);
		// `edit` stays active and callable but must not be declared, or the model sees two editors.
		expect(declaredNames).toContain("file_edit");
		expect(declaredNames).not.toContain("edit");
		expect(head.sections?.tools).toContain("file_edit");
		expect(head.sections?.tools).not.toContain("- edit:");
		expect(head.sections?.rules).not.toContain("Batch separate locations in one file into one edit call");
		expect(harness.session.systemPrompt).not.toContain("- edit:");
	});

	it("still executes a hidden tool when the model calls it anyway", async () => {
		const harness = await createHarness({
			modules: [{ name: "file-edit", factory: fileEditModule }],
			initialActiveToolNames: ["read", "bash", "edit", "write", "file_edit"],
		});
		harnesses.push(harness);
		const record: TaskRecord = { requests: [], toolCalls: [] };
		harness.setResponses(
			recordRequests(record, [
				fauxAssistantMessage([fauxToolCall("edit", { path: "x.txt", edits: [{ oldText: "a", newText: "b" }] })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]),
		);
		await harness.session.prompt("edit x.txt");

		const result = harness.session.messages.find((message) => message.role === "toolResult");
		if (result?.role !== "toolResult") throw new Error("expected a tool result");
		expect(result.toolName).toBe("edit");
		// The file does not exist, so the tool must fail on the file, not on being hidden.
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("Could not edit file");
	});
});
