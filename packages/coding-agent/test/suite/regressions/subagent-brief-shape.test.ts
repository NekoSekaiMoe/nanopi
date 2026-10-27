import { fauxAssistantMessage, fauxToolCall } from "@nanopi/pi-ai";
import { Type } from "typebox";
import { describe, expect, test } from "vitest";
import type { ModuleApi } from "../../../src/core/modules/types.ts";
import { createHarness, getToolResult } from "../harness.ts";

/**
 * Regression for the subagent brief contract.
 *
 * The brief format (GOAL / CONTEXT / EXPECTED OUTPUT / STOP RULES) is stated
 * only in prose, so the parts a caller can observe are pinned here:
 *
 * - a brief missing STOP RULES is passed through verbatim instead of being
 *   silently patched or refused, and
 * - the declaration the model reads names all four sections, so dropping one
 *   from the prompt fails a test rather than quietly degrading child output.
 *
 * The four section names live in the `task` parameter, not in the description:
 * the task field is where the model writes the brief, and the description that
 * repeated them cost ~600 characters per request on top of the schema.
 */

describe("subagent brief contract", () => {
	test("a brief without STOP RULES reaches the child verbatim", async () => {
		const captured: Array<{ task: string; tools: string }> = [];
		const stub: (pi: ModuleApi) => void = (pi) => {
			pi.registerTool({
				name: "subagent",
				label: "Subagent",
				description: "test stub",
				parameters: Type.Object({
					action: Type.String(),
					task: Type.Optional(Type.String()),
					tools: Type.Optional(Type.String()),
				}),
				async execute(_id, params: { action: string; task?: string; tools?: string }) {
					captured.push({ task: params.task ?? "", tools: params.tools ?? "" });
					return { content: [{ type: "text" as const, text: "spawned" }], details: {} };
				},
			});
		};
		const harness = await createHarness({ modules: [stub] });
		const brief = "GOAL: rename the retry constant\nCONTEXT: src/retry.ts\nEXPECTED OUTPUT: a diff";
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("subagent", { action: "spawn", task: brief })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("spawned"),
			]);
			await harness.session.prompt("delegate the rename");
			expect(getToolResult(harness, "subagent").content).toBeTruthy();
		} finally {
			harness.cleanup();
		}
		expect(captured).toHaveLength(1);
		expect(captured[0].task).toBe(brief);
	});
});

describe("subagent description", () => {
	test("names every section the brief contract requires", async () => {
		const { default: subagent } = await import("../../../src/extras/pi-subagent-mini/src/index.ts");
		const descriptions: string[] = [];
		const toolTexts: string[] = [];
		const pi = {
			registerTool(tool: { description: string; parameters: unknown }) {
				descriptions.push(tool.description);
				toolTexts.push(JSON.stringify(tool.parameters));
			},
			on() {
				return () => undefined;
			},
			getModuleNames() {
				return ["pi-subagent-mini"];
			},
		} as unknown as ModuleApi;
		subagent(pi);
		const description = descriptions[0] ?? "";
		const declaration = `${description}\n${toolTexts[0] ?? ""}`;
		for (const section of ["GOAL", "CONTEXT", "EXPECTED OUTPUT", "STOP RULES"]) {
			expect(declaration).toContain(section);
		}
		// The child cannot see the parent's conversation; that is what makes a
		// self-contained brief mandatory rather than a style preference.
		expect(description).toMatch(/only thing the main agent reads/i);
	});
});
