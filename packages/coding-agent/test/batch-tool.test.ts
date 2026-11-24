import { describe, expect, it } from "vitest";
import type { ModuleToolContext, ModuleToolsSurface, ToolDefinition } from "../src/core/modules/types.ts";
import { registerBatchTool } from "../src/modules/batch/index.ts";

function captureTool(): ToolDefinition {
	let tool: ToolDefinition | undefined;
	const pi = {
		registerTool(definition: ToolDefinition) {
			tool = definition;
		},
	} as unknown as ModuleToolsSurface;
	registerBatchTool(pi);
	if (!tool) throw new Error("registerBatchTool did not register a tool");
	return tool;
}

function toolContext(
	names: string[],
	execute: (name: string, args: unknown, options?: unknown) => Promise<unknown>,
): ModuleToolContext {
	return {
		tools: names.map((name) => ({ name })),
		executeTool: execute,
	} as unknown as ModuleToolContext;
}

describe("execute_many batch tool", () => {
	it("registers hidden and batches calls in order through executeTool", async () => {
		const tool = captureTool();
		expect(tool.exposure).toBe("hidden");

		const calls: Array<{ name: string; args: unknown }> = [];
		const ctx = toolContext(["read", "bash"], async (name, args) => {
			calls.push({ name, args });
			return {
				toolCall: { type: "toolCall", id: "n", name, arguments: args as never },
				result: { content: [{ type: "text", text: `ok ${name}` }], details: {}, isError: false },
				isError: false,
			};
		});

		const result = await tool.execute(
			"batch-1",
			{
				calls: [
					{ name: "read", arguments: { path: "/a" } },
					{ name: "bash", arguments: { command: "ls" } },
				],
			},
			undefined,
			undefined,
			ctx,
		);

		expect(calls).toEqual([
			{ name: "read", args: { path: "/a" } },
			{ name: "bash", args: { command: "ls" } },
		]);
		const text = result.content.map((block) => ("text" in block ? block.text : "")).join("\n");
		expect(text).toContain("[0] read: ok");
		expect(text).toContain("[1] bash: ok");
	});

	it("runs independent calls concurrently when parallel is set", async () => {
		const tool = captureTool();
		let inFlight = 0;
		let peak = 0;
		const ctx = toolContext(["read", "bash"], async (name, args) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 5));
			inFlight -= 1;
			return {
				toolCall: { type: "toolCall", id: "n", name, arguments: args as never },
				result: { content: [{ type: "text", text: `ok ${name}` }], details: {}, isError: false },
				isError: false,
			};
		});

		await tool.execute(
			"batch-2",
			{
				calls: [
					{ name: "read", arguments: {} },
					{ name: "bash", arguments: {} },
				],
				parallel: true,
			},
			undefined,
			undefined,
			ctx,
		);
		expect(peak).toBe(2);
	});

	it("returns an error entry for a tool that is not callable", async () => {
		const tool = captureTool();
		const ctx = toolContext(["read"], async () => {
			throw new Error("should not be called");
		});
		const result = await tool.execute(
			"batch-3",
			{ calls: [{ name: "secrets", arguments: {} }] },
			undefined,
			undefined,
			ctx,
		);
		const text = result.content.map((block) => ("text" in block ? block.text : "")).join("\n");
		expect(text).toContain('Tool "secrets" is not callable.');
	});

	it("stops a sequential batch when the signal aborts", async () => {
		const tool = captureTool();
		const controller = new AbortController();
		controller.abort();
		let called = false;
		const ctx = toolContext(["read"], async () => {
			called = true;
			return {
				toolCall: { type: "toolCall", id: "n", name: "read", arguments: {} },
				result: { content: [], details: {}, isError: false },
				isError: false,
			};
		});
		await expect(
			tool.execute("batch-4", { calls: [{ name: "read", arguments: {} }] }, controller.signal, undefined, ctx),
		).rejects.toThrow(/aborted/);
		expect(called).toBe(false);
	});

	it("advertises callable tool names in its loadout description", () => {
		const tool = captureTool();
		const changes = tool.prepareLoadout?.({
			declared: [],
			callable: [
				{
					name: "read",
					label: "read",
					description: "",
					parameters: { type: "object" },
					execute: async () => ({ content: [], details: {} }),
				} as never,
				{
					name: "bash",
					label: "bash",
					description: "",
					parameters: { type: "object" },
					execute: async () => ({ content: [], details: {} }),
				} as never,
			],
			registered: [],
			getExposure: () => "direct",
			getNamespace: () => undefined,
			getPromptGuidelines: () => [],
		});
		expect(changes?.descriptions?.execute_many).toContain("Callable tools: read, bash");
	});
});
