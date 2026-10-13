import type { AgentTool } from "@nanopi/pi-agent-core";
import { describe, expect, test } from "vitest";
import type { ModuleApi, ToolDefinition, ToolLoadout } from "../src/core/modules/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { registerApplyPatchTool } from "../src/extras/pi-fake-codex/src/apply-patch.ts";

/** Minimal stand-in for a named tool; the loadout contract only reads `name` here. */
const namedTool = (name: string): AgentTool => ({ name }) as unknown as AgentTool;

const makeLoadout = (declared: string[]): ToolLoadout => ({
	declared: declared.map(namedTool),
	callable: [],
	registered: [],
	getExposure: () => "direct",
	getNamespace: () => undefined,
	getPromptGuidelines: () => [],
});

function registerAlias(): ToolDefinition | undefined {
	const registered: ToolDefinition[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition) => {
			registered.push(tool);
		},
		on: () => () => {},
	};
	registerApplyPatchTool(pi as unknown as ModuleApi);
	return registered[0];
}

describe("pi-fake-codex apply_patch alias", () => {
	test("is built from the edit tool definition", () => {
		const alias = registerAlias();

		expect(alias?.name).toBe("apply_patch");
		// The usage contract lives in edit's declaration description; the alias inherits it.
		expect(alias?.description).toBe(createEditToolDefinition(process.cwd()).description);
		expect(Object.keys((alias?.parameters as { properties: Record<string, unknown> }).properties)).toEqual([
			"path",
			"edits",
		]);
	});

	test("hides the edit declaration while apply_patch is declared", () => {
		const alias = registerAlias();

		expect(alias?.prepareLoadout?.(makeLoadout(["read", "bash", "edit", "write", "apply_patch"]))).toEqual({
			hiddenDeclarations: ["edit"],
		});
	});

	test("leaves the loadout alone when edit is not declared", () => {
		const alias = registerAlias();

		expect(alias?.prepareLoadout?.(makeLoadout(["read", "bash", "apply_patch"]))).toBeUndefined();
	});
});
