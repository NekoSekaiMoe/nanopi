import type { AgentTool } from "@nanopi/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@nanopi/pi-ai";
import { createExtraExtension, modeEngine } from "@nanopi/pi-extra";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestExtensionsResult } from "../utilities.ts";
import { createHarness, getToolResult, type Harness } from "./harness.ts";

/** Stand-in for the built-in bash tool: plan-mode interception happens before execution. */
const fakeBashTool: AgentTool = {
	name: "bash",
	label: "Bash",
	description: "Execute a bash command",
	parameters: Type.Object({ command: Type.String() }),
	execute: async (_toolCallId, params) => ({
		content: [{ type: "text", text: `ran:${(params as { command: string }).command}` }],
		details: {},
	}),
};

const mcpEchoTool: AgentTool = {
	name: "mcp__test__echo",
	label: "Test MCP echo",
	description: "Echo tool pretending to come from an MCP server",
	parameters: Type.Object({ text: Type.String() }),
	execute: async (_toolCallId, params) => ({
		content: [{ type: "text", text: `echo:${(params as { text: string }).text}` }],
		details: {},
	}),
};

describe("extra extension integration", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		modeEngine.setMode("standard");
		modeEngine.setYolo(false);
	});

	afterEach(() => {
		modeEngine.setMode("standard");
		modeEngine.setYolo(false);
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("registers the yolo flag and the plan and mode commands", async () => {
		const result = await createTestExtensionsResult([createExtraExtension]);
		const flags = result.extensions.flatMap((extension) => [...extension.flags.keys()]);
		const commands = result.extensions.flatMap((extension) => [...extension.commands.keys()]);
		expect(flags).toContain("yolo");
		expect(commands).toContain("plan");
		expect(commands).toContain("mode");
	});

	it("plan mode blocks non-whitelisted shell commands but allows ls and read", async () => {
		modeEngine.setMode("plan");
		const harness = await createHarness({
			tools: [fakeBashTool, mcpEchoTool],
			extensionFactories: [createExtraExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "rm -rf /important" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("after rm"),
		]);
		await harness.session.prompt("clean up");
		const blocked = getToolResult(harness, "bash");
		expect(blocked.isError).toBe(true);
		expect(blocked.content[0]).toMatchObject({ text: expect.stringContaining("plan mode") });

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "ls -la" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("after ls"),
		]);
		await harness.session.prompt("list files");
		const allowed = getToolResult(harness, "bash");
		expect(allowed.isError).toBe(false);

		// Plan-mode guidance lands in the system prompt of the run.
		const prompt = getCurrentSystemPrompt(harness.session.messages);
		expect(prompt).toContain("PLAN MODE");
	});

	it("blocks mcp__* tool calls in the main agent in every mode", async () => {
		const harness = await createHarness({
			tools: [fakeBashTool, mcpEchoTool],
			extensionFactories: [createExtraExtension],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("mcp__test__echo", { text: "hi" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("after echo"),
		]);
		await harness.session.prompt("echo via mcp");
		const result = getToolResult(harness, "mcp__test__echo");
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("subagent-only") });
	});
});
