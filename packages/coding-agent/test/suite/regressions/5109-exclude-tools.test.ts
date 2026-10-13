import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ModuleFactory } from "../../../src/index.ts";
import { createHarness } from "../harness.ts";

function toolNames(tools: Array<{ name: string }>): string[] {
	return tools.map((tool) => tool.name).sort();
}

describe("regression #5109: exclude tools", () => {
	const modules: ModuleFactory[] = [
		(nanopi) => {
			nanopi.on("session_start", () => {
				nanopi.registerTool({
					name: "ask_question",
					label: "Ask Question",
					description: "Ask a question",
					promptSnippet: "Ask a question",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				});
				nanopi.registerTool({
					name: "dynamic_tool",
					label: "Dynamic Tool",
					description: "Dynamic test tool",
					promptSnippet: "Run dynamic test behavior",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "ok" }],
						details: {},
					}),
				});
			});
		},
	];

	it("filters built-in and extension tools from available and active tools", async () => {
		const harness = await createHarness({
			excludedToolNames: ["read", "ask_question"],
			modules,
		});
		try {
			await harness.session.bindModules({});

			const allToolNames = toolNames(harness.session.getAllTools());
			expect(allToolNames).not.toContain("read");
			expect(allToolNames).not.toContain("ask_question");
			expect(allToolNames).toContain("bash");
			expect(allToolNames).toContain("dynamic_tool");
			expect(harness.session.getActiveToolNames().sort()).toEqual(["bash", "dynamic_tool", "edit", "write"]);
			expect(harness.session.systemPrompt).not.toContain("- read:");
			expect(harness.session.systemPrompt).not.toContain("ask_question");
			expect(harness.session.systemPrompt).toContain("- dynamic_tool: Run dynamic test behavior");
		} finally {
			harness.cleanup();
		}
	});

	it("lets excluded tools override the allowlist", async () => {
		const harness = await createHarness({
			allowedToolNames: ["read", "bash", "ask_question"],
			excludedToolNames: ["read", "ask_question"],
			initialActiveToolNames: ["read", "bash", "ask_question"],
			modules,
		});
		try {
			await harness.session.bindModules({});

			expect(toolNames(harness.session.getAllTools())).toEqual(["bash"]);
			expect(harness.session.getActiveToolNames()).toEqual(["bash"]);
			expect(harness.session.systemPrompt).toContain("- bash:");
			expect(harness.session.systemPrompt).not.toContain("- read:");
			expect(harness.session.systemPrompt).not.toContain("ask_question");
		} finally {
			harness.cleanup();
		}
	});

	it("matches allowlist and denylist patterns", async () => {
		const harness = await createHarness({
			allowedToolNames: ["*_tool", "ask_*", "re*"],
			excludedToolNames: ["ask*"],
			initialActiveToolNames: ["*_tool", "ask_*", "re*"],
			modules,
		});
		try {
			await harness.session.bindModules({});

			// Patterns that match a tool activate it like its name.
			expect(toolNames(harness.session.getAllTools())).toEqual(["dynamic_tool", "read"]);
			expect(harness.session.getActiveToolNames().sort()).toEqual(["dynamic_tool", "read"]);
		} finally {
			harness.cleanup();
		}
	});
});
